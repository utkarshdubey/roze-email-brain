// What `generate` needs out of Gmail and in what order: full reads for mail the user took part in (sent,
// starred, or pulled on demand), and a two-year header skim that finds the rest without paying for bodies.
// Both are resumable and deterministically ordered.

import { mapAtLimitedConcurrency, type PipelineContext } from "../context.js";
import { isExhaustedQuota, isSkippableGmailItem, type GmailProfile } from "../gmail/client.js";
import { collapseHeadersToThreads, looksLikeAHuman, type EmailThread, type MessageHeader } from "../types.js";
import {
  appendHeaderRows,
  readCachedHeaderRows,
  readCachedThread,
  readOnDemandThreadIds,
  writeCachedThread,
} from "./cache.js";

/** The two explicit signals that a thread matters; both earn full reads for all time. */
const FULL_READ_QUERIES = ["in:sent -in:chats", "is:starred -in:chats"];
// Updates and Forums stay in — acceptance notices, applicant-tracking offers, and receipts land there;
// Promotions and Social are marketing. Chat conversations list as messages but cannot be fetched.
const SKIM_QUERY = "newer_than:2y -in:sent -in:chats -category:promotions -category:social";
/**
 * Each already fails looksLikeAHuman, so excluding them at the listing keeps the same senders while
 * fetching half as many headers. Tokens that also appear in human display names are absent.
 */
export const AUTOMATED_SENDER_TERMS = [
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "notifications",
  "notification",
  "notify",
  "mailer",
  "newsletter",
  "digest",
  "alerts",
  "alert",
  "billing",
  "marketing",
  "updates",
  "receipts",
  "invoice",
];
const SKIM_SAMPLE = 1_500;
const DOMAIN = /^[a-z0-9.-]+$/u;
const WORKERS = 16;

interface ThreadIngestClient {
  listThreadIds(query: string, limit?: number): Promise<string[]>;
  fetchThread(id: string): Promise<EmailThread>;
}
interface HeaderIngestClient {
  listMessageIds(query: string, limit?: number): Promise<string[]>;
  fetchMessageHeaders(id: string): Promise<MessageHeader>;
}
export interface GmailReader extends ThreadIngestClient, HeaderIngestClient {
  getProfile(): Promise<GmailProfile>;
}

export function sortThreads(threads: EmailThread[]): EmailThread[] {
  return threads.sort(
    (a, b) => (a.messages[0]?.timestamp ?? 0) - (b.messages[0]?.timestamp ?? 0) || a.id.localeCompare(b.id),
  );
}

/** Threads the agent pulled on demand join the next build for free. */
export async function listParticipatedThreadIds(
  client: ThreadIngestClient,
  context: PipelineContext,
): Promise<string[]> {
  const listed: string[] = [];
  for (const query of FULL_READ_QUERIES) {
    listed.push(...(await client.listThreadIds(query)));
  }
  return [...new Set([...listed, ...readOnDemandThreadIds(context.paths)])];
}

/** One file per thread makes interrupted reads resumable; cached threads cost no Gmail calls. */
export async function fetchThreadsById(
  client: ThreadIngestClient,
  ids: readonly string[],
  context: PipelineContext,
  label = "threads",
): Promise<EmailThread[]> {
  const unique = [...new Set(ids)];
  const found = new Map<string, EmailThread>();
  const todo: string[] = [];
  for (const id of unique) {
    const cached = readCachedThread(id, context.paths);
    if (cached) found.set(id, cached);
    else todo.push(id);
  }
  let done = unique.length - todo.length;
  const skipped: string[] = [];
  context.log(label, done, unique.length);
  await mapAtLimitedConcurrency(
    todo,
    WORKERS,
    async (id) => {
      let thread: EmailThread;
      try {
        thread = await client.fetchThread(id);
      } catch (error) {
        // A chat conversation, vanished thread, or exhausted quota must not abort a build; the thread is
        // left out and the next generate resumes it from the cache boundary.
        if (!isSkippableGmailItem(error) && !isExhaustedQuota(error)) throw error;
        skipped.push(`${id} (${(error as Error).message.slice(0, 80)})`);
        return;
      }
      if (thread.id !== id)
        throw new Error(`Gmail returned thread ${thread.id || "(missing id)"} while fetching ${id}`);
      writeCachedThread(thread, context.paths);
      found.set(id, thread);
    },
    () => context.log(label, ++done, unique.length),
  );
  if (skipped.length)
    context.log(
      `  warning: ${skipped.length} thread(s) skipped (chat conversations, removed mail, or Gmail quota); ` +
        `rerun generate to resume them: ${skipped.slice(0, 3).join("; ")}${skipped.length > 3 ? " …" : ""}`,
    );
  return sortThreads(unique.flatMap((id) => found.get(id) ?? []));
}

/** Domains whose every cached header is automated: three rows of proof, sixty domains at most. */
export function learnAutomatedDomains(rows: readonly MessageHeader[]): string[] {
  const perDomain = new Map<string, { rows: number; human: number }>();
  for (const row of rows) {
    const domain = row.fromEmail.toLowerCase().split("@")[1] ?? "";
    if (!DOMAIN.test(domain)) continue;
    const count = perDomain.get(domain) ?? { rows: 0, human: 0 };
    count.rows += 1;
    count.human += Number(looksLikeAHuman(row));
    perDomain.set(domain, count);
  }
  return [...perDomain]
    .filter(([, count]) => count.rows >= 3 && count.human === 0)
    .sort((a, b) => b[1].rows - a[1].rows || a[0].localeCompare(b[0]))
    .slice(0, 60)
    .map(([domain]) => domain);
}

export function buildSkimQuery(excludedDomains: readonly string[] = []): string {
  return [
    SKIM_QUERY,
    ...AUTOMATED_SENDER_TERMS.map((term) => `-from:${term}`),
    ...excludedDomains.map((domain) => `-from:${domain}`),
  ].join(" ");
}

async function fetchMissingHeaders(
  client: HeaderIngestClient,
  ids: readonly string[],
  context: PipelineContext,
  label: string,
): Promise<MessageHeader[]> {
  const rows: Array<MessageHeader | undefined> = new Array(ids.length);
  context.log(label, 0, ids.length);
  let complete: MessageHeader[] = [];
  try {
    await mapAtLimitedConcurrency(
      ids,
      WORKERS,
      async (id, index) => {
        let row: MessageHeader;
        try {
          row = await client.fetchMessageHeaders(id);
        } catch (error) {
          if (isSkippableGmailItem(error)) return;
          throw error;
        }
        if (row.id !== id) throw new Error(`Gmail returned header ${row.id || "(missing id)"} while fetching ${id}`);
        rows[index] = row;
      },
      (done) => context.log(label, done, ids.length),
    );
  } finally {
    // Successful rows are durable even when siblings fail, so the next run retries only failures.
    complete = rows.flatMap((row) => row ?? []);
    appendHeaderRows(complete, context.paths);
  }
  return complete;
}

/**
 * "fast" excludes automated senders at the listing (a newest-first sample teaches which bulk domains to
 * skip) so people surface in minutes; "complete" lists everything, so promotion can still reach the
 * automated senders that matter.
 */
export async function fetchRecentInboxHeaders(
  client: HeaderIngestClient,
  context: PipelineContext,
  mode: "fast" | "complete" = "fast",
): Promise<MessageHeader[]> {
  // A cached row without a snippet is refetched; a metadata read is free and the index needs the snippet.
  const byId = new Map(
    readCachedHeaderRows(context.paths, (message) => context.log(message))
      .filter((row) => row.snippet !== undefined)
      .map((row) => [row.id, row]),
  );
  const fetchUncached = async (ids: readonly string[], label: string): Promise<void> => {
    const todo = ids.filter((id) => !byId.has(id));
    for (const row of await fetchMissingHeaders(client, todo, context, label)) {
      byId.set(row.id, row);
    }
  };
  if (mode === "fast") {
    await fetchUncached(await client.listMessageIds(buildSkimQuery(), SKIM_SAMPLE), "skim sample");
    const excluded = learnAutomatedDomains([...byId.values()]);
    context.log(
      `  skim excludes ${AUTOMATED_SENDER_TERMS.length} automated sender terms and ` +
        `${excluded.length} learned bulk domains`,
    );
    await fetchUncached(await client.listMessageIds(buildSkimQuery(excluded), 100_000), "skim");
  } else {
    await fetchUncached(await client.listMessageIds(SKIM_QUERY, 100_000), "skim backfill");
  }
  return collapseHeadersToThreads([...byId.values()]).sort(
    (a, b) => b.timestamp - a.timestamp || a.threadId.localeCompare(b.threadId),
  );
}
