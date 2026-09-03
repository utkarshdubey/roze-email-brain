// The grounding audit over `[t:<thread id> <YYYY-MM-DD>]`. A citation is grounded when the agent copied
// it from a view or tally row it read (that line was generated from that thread and day), or when it
// opened the thread's raw messages and the cited day heads one of them. Everything else goes into one of
// three buckets, which the agent loop turns into a repair round and then a visible warning.
import { readFileSync } from "node:fs";

import { renderThreadAsMarkdown } from "../brain/renderEvidence.js";
import { readPublishedBrain } from "../brain/storage.js";
import { readCachedThread } from "../ingest/cache.js";
import { localizeThread } from "../shared/dates.js";
import { resolveMemoryFile } from "./memoryPaths.js";

export const CITATION = /\[t:([0-9a-f]{8,})\s+(\d{4}-\d{2}-\d{2})\]/gu;

/** Claims that the brain holds no answer; each gets one extra round of header reads. */
export const ABSENCE = new RegExp(
  String.raw`\b(nothing in your (e-?mail|mail|inbox)|no (such )?(e-?mail|record|evidence|message|thread)s?\b|` +
    String.raw`not (able to )?(find|locate|verify|confirm|determine|identify)|` +
    String.raw`unable to (find|locate|verify|confirm|determine|identify)|` +
    String.raw`could(n.t| not) (find|locate|verify|confirm|determine|identify)|` +
    String.raw`can(not|.t) (find|locate|verify|confirm|determine|identify))`,
  "iu",
);

export interface CitationAudit {
  /** The thread exists and the day fits, but the agent never opened its raw messages. */
  unread: string[];
  /** The thread exists, but no message in it is dated that day. */
  invalid: string[];
  /** No such thread in the brain or in the on-demand cache. */
  missing: string[];
}

export const auditKeys = (audit: CitationAudit): string[] => [...audit.unread, ...audit.invalid, ...audit.missing];

export const citationKeysIn = (text: string): string[] =>
  [...text.matchAll(CITATION)].map((match) => `${match[1]} ${match[2]}`);

type PublishedBrain = ReturnType<typeof readPublishedBrain>;

/** The published evidence file, else the on-demand cache `read_email` fills. */
function readThreadMessages(root: string, threadId: string, published: PublishedBrain): string | undefined {
  try {
    return readFileSync(resolveMemoryFile(root, `evidence/threads/${threadId}.md`), "utf8");
  } catch {
    // Live fetches are cached under the published account's namespace, where read_email writes.
    const cached = readCachedThread(threadId, published.paths);
    return cached ? renderThreadAsMarkdown(localizeThread(cached, published.timezone), "") : undefined;
  }
}

export function auditCitations(
  answer: string,
  root: string,
  readThreads: ReadonlySet<string>,
  readCitations: ReadonlySet<string> = new Set(),
): CitationAudit {
  const audit: CitationAudit = { unread: [], invalid: [], missing: [] };
  const seen = new Set<string>();
  const published = readPublishedBrain(root);
  for (const [, threadId, day] of answer.matchAll(CITATION)) {
    const key = `${threadId} ${day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (readCitations.has(key)) continue;
    const source = readThreadMessages(root, threadId!, published);
    if (source === undefined) audit.missing.push(key);
    else if (!source.split("\n").some((line) => line.startsWith(`## ${day}T`))) audit.invalid.push(key);
    else if (!readThreads.has(threadId!)) audit.unread.push(key);
  }
  return audit;
}

/** One sentence naming what failed, for the repair round and for the warning on the answer. */
export function describeAudit(audit: CitationAudit): string {
  const parts: string[] = [];
  if (audit.unread.length) parts.push(`cited without reading the thread: ${audit.unread.join(", ")}`);
  if (audit.invalid.length) parts.push(`no message on that day in the thread: ${audit.invalid.join(", ")}`);
  if (audit.missing.length) parts.push(`thread not in the brain: ${audit.missing.join(", ")}`);
  return parts.join("; ");
}
