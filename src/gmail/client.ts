// A read-only Gmail client that paces itself under the per-user quota, retries what a repeat can fix, and
// returns EmailThread / MessageHeader values. Nothing above it ever sees a raw Gmail resource.

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
/** The per-user limit is per minute; after a quota answer every worker waits for the window to reset. */
const QUOTA_COOLDOWN_MS = 61_000;
// Gmail allows 250 quota units per user per second; pacing by unit cost at 85% headroom gives about 42
// metadata reads/s and 21 full thread reads/s, leaving room for retries.
const QUOTA_UNITS_PER_SECOND = 250;
const QUOTA_HEADROOM = 0.85;
const MS_PER_UNIT = 1_000 / (QUOTA_UNITS_PER_SECOND * QUOTA_HEADROOM);
const UNITS = { profile: 1, list: 5, message: 5, thread: 10 } as const;

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
  /** Earliest the next request may leave, advanced by each request's own quota cost. */
  #nextRequestAt = 0;
  /** Set by a quota answer; every worker on this client holds off until the window has reset. */
  #pausedUntil = 0;

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
  }

  async #takeRequestSlot(units: number): Promise<void> {
    if (this.#pausedUntil > Date.now()) {
      await this.#sleep(this.#pausedUntil - Date.now());
    }
    const now = Date.now();
    const slot = Math.max(now, this.#nextRequestAt);
    this.#nextRequestAt = slot + units * MS_PER_UNIT;
    if (slot > now) {
      await this.#sleep(slot - now);
    }
  }

  async #pauseForQuotaWindow(): Promise<void> {
    this.#pausedUntil = Math.max(this.#pausedUntil, Date.now() + Math.min(RETRY_CAP_MS, QUOTA_COOLDOWN_MS));
    await this.#sleep(this.#pausedUntil - Date.now());
  }

  async #request(path: string, units: number, parameters?: URLSearchParams): Promise<Response> {
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
        await this.#takeRequestSlot(units);
        response = await this.#fetch(url, { headers: { authorization: `Bearer ${token}` } });
      } catch (error) {
        // A transport failure carries no status, so it spends the shorter network budget.
        if (attempt + 1 >= ATTEMPTS)
          throw new Error(`Gmail request failed after ${ATTEMPTS} attempts`, { cause: error });
        await this.#sleep(exponentialBackoffMs(attempt));
        continue;
      }
      if (response.ok) return response;
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
        await this.#pauseForQuotaWindow();
        continue;
      }
      await this.#sleep(retryDelayMs(response, attempt));
    }
    throw new Error("Unreachable Gmail retry state");
  }

  async #read<Output>(
    path: string,
    units: number,
    schema: z.ZodType<Output>,
    parameters?: URLSearchParams,
  ): Promise<Output> {
    const response = await this.#request(path, units, parameters);
    try {
      return schema.parse(await response.json());
    } catch (error) {
      throw new Error("Gmail returned invalid JSON or an unexpected document", { cause: error });
    }
  }

  getProfile(): Promise<GmailProfile> {
    return this.#read("profile", UNITS.profile, profileSchema);
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
      const page = await this.#read(resource, UNITS.list, pageSchema, parameters);
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
        UNITS.message,
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
      UNITS.thread,
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
      await this.#read(`messages/${encodeURIComponent(id)}`, UNITS.message, gmailMessageSchema, parameters),
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
