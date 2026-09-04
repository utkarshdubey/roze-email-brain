// What `generate` needs out of Gmail and in what order: full reads for mail the user took part in (sent,
// starred, or pulled on demand), and a bounded recent skim that finds the rest — headers in the fast pass,
// one full read per uncovered thread in the backfill. Both are resumable and deterministically ordered.

import { mapAtLimitedConcurrency, type PipelineContext } from "../context.js";
import { isExhaustedQuota, isSkippableGmailItem, type GmailProfile, type ListedMessage } from "../gmail/client.js";
import { cleanSnippet } from "../shared/text.js";
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
export const DEFAULT_RECENT_MONTHS = 24;
const SKIM_FILTERS = "-in:sent -in:chats -category:promotions -category:social";
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
  /** Optional: a client that can tell single-message threads apart lets them be read at half the units. */
  listMessages?(query: string, limit?: number): Promise<ListedMessage[]>;
  fetchSingleMessageThread?(messageId: string, threadId: string): Promise<EmailThread>;
}
/** The configured recent skim as Gmail lists it: every thread and the message ids matched inside it. */
export type SkimListing = ReadonlyMap<string, readonly string[]>;
/**
 * One listing pass (five units per 500 messages) instead of a thread listing, because it also says how many
 * messages each thread has: 97% of inbox threads are a single message, and those are read as one message (5
 * units) rather than as a thread (10). A client without message listing yields threads of unknown size, which
 * are always read in full. A message outside the query (older than the window, in an excluded category) is not
 * fetched with a single-message read; `read_email` still fetches such a thread whole.
 */
export async function listSkimThreads(
  client: ThreadIngestClient,
  recentMonths = DEFAULT_RECENT_MONTHS,
): Promise<SkimListing> {
  const listing = new Map<string, string[]>();
  if (!client.listMessages) {
    for (const id of await client.listThreadIds(buildSkimWindowQuery(recentMonths), 100_000)) listing.set(id, []);
    return listing;
  }
  for (const row of await client.listMessages(buildSkimWindowQuery(recentMonths), 100_000)) {
    if (!row.threadId) continue;
    listing.set(row.threadId, [...(listing.get(row.threadId) ?? []), row.id]);
  }
  return listing;
}
interface HeaderIngestClient {
  listMessageIds(query: string, limit?: number): Promise<string[]>;
  fetchMessageHeaders(id: string): Promise<MessageHeader>;
}
/** The skim lists headers for speed and full threads for the backfill, so it needs both listings. */
type SkimIngestClient = ThreadIngestClient & HeaderIngestClient;
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
  listing?: SkimListing,
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
      const messageIds = listing?.get(id);
      try {
        thread =
          messageIds?.length === 1 && client.fetchSingleMessageThread
            ? await client.fetchSingleMessageThread(messageIds[0]!, id)
            : await client.fetchThread(id);
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

function requireRecentMonths(recentMonths: number): void {
  if (!Number.isSafeInteger(recentMonths) || recentMonths <= 0) {
    throw new RangeError("recentMonths must be a positive integer");
  }
}

export function describeRecentWindow(recentMonths: number): string {
  requireRecentMonths(recentMonths);
  if (recentMonths === DEFAULT_RECENT_MONTHS) return "last two years";
  return recentMonths === 1 ? "last month" : `last ${recentMonths} months`;
}

function buildSkimWindowQuery(recentMonths: number): string {
  requireRecentMonths(recentMonths);
  const age = recentMonths === DEFAULT_RECENT_MONTHS ? "newer_than:2y" : `newer_than:${recentMonths}m`;
  return `${age} ${SKIM_FILTERS}`;
}

export function buildSkimQuery(
  recentMonths = DEFAULT_RECENT_MONTHS,
  excludedDomains: readonly string[] = [],
): string {
  return [
    buildSkimWindowQuery(recentMonths),
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
 * The same row `fetchMessageHeaders` would return for the thread's first message, so an index row built
 * from a full thread renders byte-identically to one built from a metadata read: identical fields off the
 * identical parse, with the snippet cleaned here exactly as the metadata path cleans it. `count` is the
 * thread's own message count, which is what "messages seen in that thread" now means once the whole thread
 * has been read.
 */
export function headerRowFromThread(thread: EmailThread): MessageHeader | undefined {
  const first = thread.messages[0];
  if (!first) return undefined;
  return {
    id: first.id,
    threadId: first.threadId || thread.id,
    timestamp: first.timestamp,
    day: first.day,
    fromName: first.fromName,
    fromEmail: first.fromEmail,
    subject: first.subject,
    labels: first.labels,
    listId: first.listId,
    count: thread.messages.length,
    snippet: cleanSnippet(first.snippet),
  };
}

/**
 * "fast" excludes automated senders at the listing (a newest-first sample teaches which bulk domains to
 * skip) so people surface in minutes; "complete" lists everything, so promotion can still reach the
 * automated senders that matter.
 *
 * The backfill reads each uncovered thread once in full instead of buying a metadata header first: the body
 * phase then finds it already in the thread cache, so a skim thread costs one Gmail read instead of two, and
 * a single-message thread costs one message read (see `listSkimThreads`). The fast pass stays header-only —
 * its job is to surface people within minutes, and a header is half the units and a fraction of the bytes.
 */
export async function fetchRecentInboxHeaders(
  client: SkimIngestClient,
  context: PipelineContext,
  mode: "fast" | "complete" = "fast",
  listing?: SkimListing,
  recentMonths = DEFAULT_RECENT_MONTHS,
): Promise<MessageHeader[]> {
  requireRecentMonths(recentMonths);
  // A cached row without a snippet is refetched because the index needs the preview.
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
  const rowsForMessageIds = (ids: ReadonlySet<string>): MessageHeader[] =>
    [...ids].flatMap((id) => byId.get(id) ?? []);
  /** Threads the fast pass already indexed keep their rows; the rest are read once, in full. */
  const backfillThreads = async (skim: SkimListing, label: string): Promise<void> => {
    const indexed = new Set([...byId.values()].map((row) => row.threadId));
    const fetched = await fetchThreadsById(
      client,
      [...skim.keys()].filter((id) => !indexed.has(id)),
      context,
      label,
      skim,
    );
    // Threads are cached one file at a time by the fetch, so an interrupted backfill resumes for free and
    // only the derived rows are rewritten.
    const rows = fetched.flatMap((thread) => headerRowFromThread(thread) ?? []);
    appendHeaderRows(rows, context.paths);
    for (const row of rows) {
      byId.set(row.id, row);
    }
  };
  let selected: MessageHeader[];
  if (mode === "fast") {
    const selectedIds = new Set(await client.listMessageIds(buildSkimQuery(recentMonths), SKIM_SAMPLE));
    await fetchUncached([...selectedIds], "skim sample");
    const sample =
      recentMonths === DEFAULT_RECENT_MONTHS ? [...byId.values()] : rowsForMessageIds(selectedIds);
    const excluded = learnAutomatedDomains(sample);
    context.log(
      `  skim excludes ${AUTOMATED_SENDER_TERMS.length} automated sender terms and ` +
        `${excluded.length} learned bulk domains`,
    );
    const ids = await client.listMessageIds(buildSkimQuery(recentMonths, excluded), 100_000);
    ids.forEach((id) => selectedIds.add(id));
    await fetchUncached(ids, "skim");
    selected = recentMonths === DEFAULT_RECENT_MONTHS ? [...byId.values()] : rowsForMessageIds(selectedIds);
  } else {
    const skim = listing ?? (await listSkimThreads(client, recentMonths));
    await backfillThreads(skim, "skim backfill");
    const selectedThreads = new Set(skim.keys());
    selected =
      recentMonths === DEFAULT_RECENT_MONTHS
        ? [...byId.values()]
        : [...byId.values()].filter((row) => selectedThreads.has(row.threadId));
  }
  return collapseHeadersToThreads(selected).sort(
    (a, b) => b.timestamp - a.timestamp || a.threadId.localeCompare(b.threadId),
  );
}
