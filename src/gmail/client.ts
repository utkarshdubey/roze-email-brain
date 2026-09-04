// A read-only Gmail client that paces itself under the per-user quota, retries what a repeat can fix, meters
// every outbound attempt by resource kind, and returns domain values. Nothing above it sees a raw resource.

import { z } from "zod";
import { cleanSnippet } from "../shared/text.js";
import type { EmailThread, MessageHeader } from "../types.js";
import { staticTokenSource, type AccessTokenSource, type GoogleCredentials } from "./auth.js";
import { describeHttpFailure, type FetchLike } from "./http.js";
import { gmailMessageSchema, parseMessage } from "./messages.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const QUOTA_REASONS = ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"];
const METADATA_HEADERS = ["From", "To", "Cc", "Subject", "Date", "List-Id"];
const ATTEMPTS = 6;
const QUOTA_ATTEMPTS = 12;
const RETRY_CAP_MS = 60_000;
// Gmail's documented ceiling is 250 quota units per user per second, and the quota answer it actually sends
// names a limit of "units per minute per user" — one some accounts hit far below the documented figure. So
// the client keeps a sliding one-minute window of the units it spent and learns the real cap: it starts at
// 85% of the documented minute, and a quota answer lowers it to 90% of what the window held when Gmail
// refused (never below a quarter of the documented minute); ten seconds of successes raise it back by 5%. A worker
// that would overflow the window waits only until enough old units age out, not a whole minute, and the
// per-second spacing still spreads requests so no burst trips a shorter limit. Measured on an account with
// a low cap: the old 61-second full stop per quota answer ran 300 reads at 4.4/s.
const QUOTA_UNITS_PER_SECOND = 250;
const QUOTA_HEADROOM = 0.85;
const WINDOW_MS = 60_000;
const MINUTE_CEILING = QUOTA_UNITS_PER_SECOND * 60 * QUOTA_HEADROOM;
const MINUTE_FLOOR = MINUTE_CEILING / 4;
const CAP_AFTER_REFUSAL = 0.9;
const CAP_RECOVERY = 1.05;
const CAP_RAISE_INTERVAL_MS = 10_000;
const MS_PER_UNIT = 1_000 / (QUOTA_UNITS_PER_SECOND * QUOTA_HEADROOM);
const QUOTA_RETRY_CAP_MS = 8_000;
const UNITS = { profile: 1, lists: 5, messages: 5, threads: 10 } as const;

const profileSchema = z.object({
  emailAddress: z.string(),
  messagesTotal: z.number().default(0),
  threadsTotal: z.number().default(0),
  historyId: z.string(),
});
const pageSchema = z.object({
  threads: z.array(z.object({ id: z.string().min(1) })).optional(),
  messages: z.array(z.object({ id: z.string().min(1), threadId: z.string().optional() })).optional(),
  nextPageToken: z.string().optional(),
});
/** One listed message: its thread is what the skim backfill and body fetch group by. */
export interface ListedMessage {
  id: string;
  threadId: string;
}
const threadSchema = z.object({ messages: z.array(gmailMessageSchema).default([]) });
export type GmailProfile = z.output<typeof profileSchema>;
export type GmailResourceKind = keyof typeof UNITS;
export interface GmailResourceUsage {
  readonly requests: number;
  readonly quotaUnits: number;
}
export interface GmailUsageSnapshot {
  readonly requests: number;
  readonly quotaUnits: number;
  readonly byResource: Readonly<Record<GmailResourceKind, GmailResourceUsage>>;
  /** Wall span from the first outbound attempt through the latest completion; zero before the first attempt. */
  readonly elapsedMs: number;
  /** The per-minute unit cap the client learned from Gmail's refusals; the documented ceiling until one arrives. */
  readonly unitsPerMinute: number;
  readonly unitsPerMinuteCeiling: number;
}

export class GmailRequestError extends Error {
  override readonly name = "GmailRequestError";
  constructor(
    message: string,
    readonly status: number,
    readonly quota = false,
  ) {
    super(message);
  }
}

export function isSkippableGmailItem(error: unknown): boolean {
  return (
    error instanceof GmailRequestError &&
    (error.status === 404 || (error.status === 400 && /precondition/iu.test(error.message)))
  );
}

export function isExhaustedQuota(error: unknown): boolean {
  return error instanceof GmailRequestError && error.status === 403 && error.quota;
}

interface GmailClientOptions {
  fetch?: FetchLike;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const exponentialBackoffMs = (attempt: number): number => Math.min(RETRY_CAP_MS, 500 * 2 ** attempt);

function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(RETRY_CAP_MS, seconds * 1_000);
  return exponentialBackoffMs(attempt);
}

export class GmailClient {
  readonly #tokens: AccessTokenSource;
  readonly #fetch: FetchLike;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;
  readonly #usage: Record<GmailResourceKind, { requests: number; quotaUnits: number }> = {
    profile: { requests: 0, quotaUnits: 0 },
    lists: { requests: 0, quotaUnits: 0 },
    messages: { requests: 0, quotaUnits: 0 },
    threads: { requests: 0, quotaUnits: 0 },
  };
  #firstRequestAt: number | undefined;
  #lastRequestCompletedAt: number | undefined;
  #activeRequests = 0;
  /** Earliest the next request may leave, advanced by each request's own quota cost. */
  #nextRequestAt = 0;
  /** Units spent in the last minute, oldest first, so the window can be summed and aged. */
  readonly #spent: Array<{ at: number; units: number }> = [];
  #spentInWindow = 0;
  /** Units per minute the client currently allows itself; adaptive, see the constants above. */
  #unitsPerMinute = MINUTE_CEILING;
  #lastCapRaiseAt = 0;

  /** A token source renews mid-build; a credentials object or bare string is spent as-is (sign-in, tests). */
  constructor(credentials: AccessTokenSource | GoogleCredentials | string, options: GmailClientOptions = {}) {
    if (typeof credentials === "string") {
      if (!credentials) throw new Error("GmailClient requires a Google access token");
      this.#tokens = staticTokenSource(credentials);
    } else if (typeof credentials.token === "function") {
      this.#tokens = credentials as AccessTokenSource;
    } else {
      if (!credentials.token) throw new Error("GmailClient requires a Google access token");
      this.#tokens = staticTokenSource(credentials.token as string);
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? wait;
    this.#now = options.now ?? Date.now;
  }

  /** Attempts are counted when fetch is invoked, including transport failures and every HTTP retry. */
  #startRequest(resource: GmailResourceKind): void {
    const startedAt = this.#now();
    this.#firstRequestAt ??= startedAt;
    this.#activeRequests += 1;
    this.#usage[resource].requests += 1;
    this.#usage[resource].quotaUnits += UNITS[resource];
  }

  #completeRequest(): void {
    const completedAt = this.#now();
    this.#activeRequests -= 1;
    this.#lastRequestCompletedAt = Math.max(this.#lastRequestCompletedAt ?? completedAt, completedAt);
  }

  /** A detached snapshot cannot mutate this client's counters. */
  getUsage(): GmailUsageSnapshot {
    const byResource = {
      profile: { ...this.#usage.profile },
      lists: { ...this.#usage.lists },
      messages: { ...this.#usage.messages },
      threads: { ...this.#usage.threads },
    };
    const resources = Object.values(byResource);
    const endedAt = this.#activeRequests > 0 ? this.#now() : this.#lastRequestCompletedAt;
    const elapsedMs = this.#firstRequestAt === undefined || endedAt === undefined ? 0 : endedAt - this.#firstRequestAt;
    return {
      requests: resources.reduce((sum, usage) => sum + usage.requests, 0),
      quotaUnits: resources.reduce((sum, usage) => sum + usage.quotaUnits, 0),
      byResource,
      elapsedMs: Math.max(0, elapsedMs),
      unitsPerMinute: this.#unitsPerMinute,
      unitsPerMinuteCeiling: MINUTE_CEILING,
    };
  }

  #ageOutSpentUnits(now: number): void {
    while (this.#spent.length && this.#spent[0]!.at <= now - WINDOW_MS) {
      this.#spentInWindow -= this.#spent.shift()!.units;
    }
  }

  /** Waits for the minute window to have room, then for the per-second spacing, then books the units. */
  async #takeRequestSlot(units: number): Promise<void> {
    let now = this.#now();
    this.#ageOutSpentUnits(now);
    while (this.#spent.length && this.#spentInWindow + units > this.#unitsPerMinute) {
      await this.#sleep(Math.max(1, this.#spent[0]!.at + WINDOW_MS - now));
      now = this.#now();
      this.#ageOutSpentUnits(now);
    }
    const slot = Math.max(now, this.#nextRequestAt);
    this.#nextRequestAt = slot + units * MS_PER_UNIT;
    if (slot > now) {
      await this.#sleep(slot - now);
    }
    this.#spent.push({ at: slot, units });
    this.#spentInWindow += units;
  }

  /** Gmail refused at this spend: learn the cap from the window, then retry after a short backoff. */
  async #learnCapFromQuotaAnswer(response: Response, attempt: number): Promise<void> {
    this.#ageOutSpentUnits(this.#now());
    this.#unitsPerMinute = Math.max(
      MINUTE_FLOOR,
      Math.min(this.#unitsPerMinute, this.#spentInWindow * CAP_AFTER_REFUSAL),
    );
    await this.#sleep(Math.min(QUOTA_RETRY_CAP_MS, retryDelayMs(response, attempt)));
  }

  /** Recovery is by time, not by count, so a long run of small requests cannot outrun a learned cap. */
  #raiseCapAfterQuietSuccesses(): void {
    const now = this.#now();
    if (now - this.#lastCapRaiseAt < CAP_RAISE_INTERVAL_MS) return;
    this.#lastCapRaiseAt = now;
    this.#unitsPerMinute = Math.min(MINUTE_CEILING, this.#unitsPerMinute * CAP_RECOVERY);
  }

  /** The minute cap the client currently believes Gmail grants this user, for build reports and tests. */
  get unitsPerMinute(): number {
    return this.#unitsPerMinute;
  }

  async #request(path: string, resource: GmailResourceKind, parameters?: URLSearchParams): Promise<Response> {
    const url = new URL(`${API}/${path.replace(/^\/+/, "")}`);
    if (parameters) {
      url.search = parameters.toString();
    }
    let renewedToken = false;
    for (let attempt = 0; attempt < QUOTA_ATTEMPTS; attempt += 1) {
      // Outside the transport retry: a failed renewal ("run roze auth") must surface as itself, not as a
      // request that failed six times.
      const token = await this.#tokens.token();
      let response: Response;
      try {
        await this.#takeRequestSlot(UNITS[resource]);
        this.#startRequest(resource);
        try {
          response = await this.#fetch(url, { headers: { authorization: `Bearer ${token}` } });
        } finally {
          this.#completeRequest();
        }
      } catch (error) {
        // A transport failure carries no status, so it spends the shorter network budget.
        if (attempt + 1 >= ATTEMPTS)
          throw new Error(`Gmail request failed after ${ATTEMPTS} attempts`, { cause: error });
        await this.#sleep(exponentialBackoffMs(attempt));
        continue;
      }
      if (response.ok) {
        this.#raiseCapAfterQuietSuccesses();
        return response;
      }
      if (response.status === 401 && !renewedToken) {
        // The access token expired while this build was running: renew once and repeat the request.
        renewedToken = true;
        this.#tokens.invalidate();
        continue;
      }
      const { detail, message } = await describeHttpFailure(response, "Gmail request");
      const quota = response.status === 403 && QUOTA_REASONS.some((reason) => detail.includes(reason));
      const retryable = quota || RETRYABLE.has(response.status);
      if (!retryable || attempt + 1 >= (quota ? QUOTA_ATTEMPTS : ATTEMPTS))
        throw new GmailRequestError(message, response.status, quota);
      if (quota) {
        await this.#learnCapFromQuotaAnswer(response, attempt);
        continue;
      }
      await this.#sleep(retryDelayMs(response, attempt));
    }
    throw new Error("Unreachable Gmail retry state");
  }

  async #read<Output>(
    path: string,
    resource: GmailResourceKind,
    schema: z.ZodType<Output>,
    parameters?: URLSearchParams,
  ): Promise<Output> {
    const response = await this.#request(path, resource, parameters);
    try {
      return schema.parse(await response.json());
    } catch (error) {
      throw new Error("Gmail returned invalid JSON or an unexpected document", { cause: error });
    }
  }

  getProfile(): Promise<GmailProfile> {
    return this.#read("profile", "profile", profileSchema);
  }

  /** A repeated pageToken would loop forever, so it is refused. */
  async #listEvery(resource: "threads" | "messages", query: string, limit: number): Promise<ListedMessage[]> {
    if (!Number.isInteger(limit) || limit < 0)
      throw new RangeError("Gmail listing limit must be a non-negative integer");
    const rows: ListedMessage[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    while (rows.length < limit) {
      const parameters = new URLSearchParams({ q: query, maxResults: String(Math.min(500, limit - rows.length)) });
      if (token) {
        parameters.set("pageToken", token);
      }
      const page = await this.#read(resource, "lists", pageSchema, parameters);
      const listed: ListedMessage[] =
        resource === "threads"
          ? (page.threads ?? []).map((row) => ({ id: row.id, threadId: row.id }))
          : (page.messages ?? []).map((row) => ({ id: row.id, threadId: row.threadId ?? "" }));
      rows.push(...listed.slice(0, limit - rows.length));
      if (!page.nextPageToken) break;
      if (seen.has(page.nextPageToken)) throw new Error("Gmail repeated a pageToken while listing mail");
      seen.add(page.nextPageToken);
      token = page.nextPageToken;
    }
    return rows;
  }

  async listThreadIds(query: string, limit = 100_000): Promise<string[]> {
    return (await this.#listEvery("threads", query, limit)).map((row) => row.id);
  }

  async listMessageIds(query: string, limit = 100_000): Promise<string[]> {
    return (await this.#listEvery("messages", query, limit)).map((row) => row.id);
  }

  /** Message ids with their thread ids, so single-message threads can be told apart before anything is read. */
  listMessages(query: string, limit = 100_000): Promise<ListedMessage[]> {
    return this.#listEvery("messages", query, limit);
  }

  /**
   * Half the units of a thread read (5, not 10), for a thread the listing showed with exactly one message.
   * Gmail's own thread id on the message is the thread's id; the caller's id only stands in if it is missing.
   */
  async fetchSingleMessageThread(messageId: string, threadId: string): Promise<EmailThread> {
    if (!messageId) throw new Error("Gmail message id must not be empty");
    const message = parseMessage(
      await this.#read(
        `messages/${encodeURIComponent(messageId)}`,
        "messages",
        gmailMessageSchema,
        new URLSearchParams({ format: "full" }),
      ),
    );
    return { id: message.threadId || threadId, messages: [message] };
  }

  async fetchThread(id: string): Promise<EmailThread> {
    if (!id) throw new Error("Gmail thread id must not be empty");
    const document = await this.#read(
      `threads/${encodeURIComponent(id)}`,
      "threads",
      threadSchema,
      new URLSearchParams({ format: "full" }),
    );
    return {
      id,
      messages: document.messages.map((message) => parseMessage(message)).sort((a, b) => a.timestamp - b.timestamp),
    };
  }

  /** Half the quota cost of a full read, and it still carries the snippet the skim index needs. */
  async fetchMessageHeaders(id: string): Promise<MessageHeader> {
    if (!id) throw new Error("Gmail message id must not be empty");
    const parameters = new URLSearchParams({ format: "metadata" });
    for (const header of METADATA_HEADERS) {
      parameters.append("metadataHeaders", header);
    }
    const message = parseMessage(
      await this.#read(`messages/${encodeURIComponent(id)}`, "messages", gmailMessageSchema, parameters),
      false,
    );
    return {
      id: message.id,
      threadId: message.threadId,
      timestamp: message.timestamp,
      day: message.day,
      fromName: message.fromName,
      fromEmail: message.fromEmail,
      subject: message.subject,
      labels: message.labels,
      listId: message.listId,
      snippet: cleanSnippet(message.snippet),
    };
  }
}
