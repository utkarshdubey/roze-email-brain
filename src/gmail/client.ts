// A read-only Gmail client that paces itself under the per-user quota, retries what a repeat can fix, and
// returns EmailThread / MessageHeader values. Nothing above it ever sees a raw Gmail resource.

import { z } from "zod";
import { cleanSnippet } from "../shared/text.js";
import type { EmailThread, MessageHeader } from "../types.js";
import type { GoogleCredentials } from "./auth.js";
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
  messages: z.array(z.object({ id: z.string().min(1) })).optional(),
  nextPageToken: z.string().optional(),
});
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
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  /** Earliest the next request may leave, advanced by each request's own quota cost. */
  #nextRequestAt = 0;
  /** Set by a quota answer; every worker on this client holds off until the window has reset. */
  #pausedUntil = 0;

  constructor(credentials: GoogleCredentials | string, options: GmailClientOptions = {}) {
    this.#token = typeof credentials === "string" ? credentials : credentials.token;
    if (!this.#token) throw new Error("GmailClient requires a Google access token");
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
    for (let attempt = 0; attempt < QUOTA_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        await this.#takeRequestSlot(units);
        response = await this.#fetch(url, { headers: { authorization: `Bearer ${this.#token}` } });
      } catch (error) {
        // A transport failure carries no status, so it spends the shorter network budget.
        if (attempt + 1 >= ATTEMPTS)
          throw new Error(`Gmail request failed after ${ATTEMPTS} attempts`, { cause: error });
        await this.#sleep(exponentialBackoffMs(attempt));
        continue;
      }
      if (response.ok) return response;
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
  async #listEveryId(resource: "threads" | "messages", query: string, limit: number): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 0)
      throw new RangeError("Gmail listing limit must be a non-negative integer");
    const ids: string[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    while (ids.length < limit) {
      const parameters = new URLSearchParams({ q: query, maxResults: String(Math.min(500, limit - ids.length)) });
      if (token) {
        parameters.set("pageToken", token);
      }
      const page = await this.#read(resource, UNITS.list, pageSchema, parameters);
      ids.push(...(page[resource] ?? []).map((row) => row.id).slice(0, limit - ids.length));
      if (!page.nextPageToken) break;
      if (seen.has(page.nextPageToken)) throw new Error("Gmail repeated a pageToken while listing mail");
      seen.add(page.nextPageToken);
      token = page.nextPageToken;
    }
    return ids;
  }

  listThreadIds(query: string, limit = 100_000): Promise<string[]> {
    return this.#listEveryId("threads", query, limit);
  }

  listMessageIds(query: string, limit = 100_000): Promise<string[]> {
    return this.#listEveryId("messages", query, limit);
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
