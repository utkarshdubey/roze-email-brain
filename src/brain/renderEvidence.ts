// Raw threads, the per-year lists that point at them, and the transaction table. The only authoritative
// layer — every other view cites into it — so these shapes are byte-stable and validated literally.
import { join } from "node:path";
import { ensureDirectory, pushToYear, writeFileAtomically, writeYearFiles } from "../shared/atomicFiles.js";
import { cleanSnippet, sliceCharacters } from "../shared/text.js";
import { parseTransaction, type Transaction } from "../memory/transactions.js";
import {
  collapseHeadersToThreads,
  looksLikeAHuman,
  type EmailMessage,
  type EmailThread,
  type MessageHeader,
} from "../types.js";
import { resolveBrainPaths } from "./storage.js";

export interface EvidenceCounts {
  threads: number;
  messages: number;
  skimThreads: number;
  bodyThreads: number;
  transactions: number;
}

const parseAddressesFromHeader = (header: string): string[] =>
  (header.match(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+/gu) ?? []).map((value) => value.toLowerCase());

function collectMessageRecipients(message: EmailMessage): string[] {
  return [...parseAddressesFromHeader(message.to), ...parseAddressesFromHeader(message.cc)];
}

function formatShortAddress(address: string, userEmail: string): string {
  return address.toLowerCase() === userEmail.toLowerCase() ? "me" : address;
}

function collectThreadParticipants(thread: EmailThread, userEmail: string): string[] {
  const seen = new Set<string>();
  const participants: string[] = [];
  for (const message of thread.messages) {
    for (const address of [message.fromEmail, ...collectMessageRecipients(message)]) {
      if (!address || address.toLowerCase() === userEmail.toLowerCase() || seen.has(address)) continue;
      seen.add(address);
      participants.push(address);
    }
  }
  return participants;
}

/** Sender-local dated headings let the offline validator prove every citation without Gmail access. */
export function renderThreadAsMarkdown(thread: EmailThread, userEmail: string): string {
  const first = thread.messages[0];
  const last = thread.messages.at(-1);
  if (!first || !last) throw new Error(`Cannot render empty email thread ${thread.id}`);
  const participants = collectThreadParticipants(thread, userEmail);
  const lines = [
    `# ${first.subject}`,
    `thread: ${thread.id}  |  messages: ${thread.messages.length}  |  ${first.day} → ${last.day}`,
    `participants: ${participants.join(", ") || "(only me)"}`,
    "",
  ];
  for (const message of thread.messages) {
    lines.push(`## ${message.date}  from: ${formatShortAddress(message.fromEmail, userEmail)}`);
    const recipients = collectMessageRecipients(message)
      .map((address) => formatShortAddress(address, userEmail))
      .join(", ");
    if (recipients) {
      lines.push(`to: ${recipients}`);
    }
    if (message.subject !== first.subject) {
      lines.push(`subject: ${message.subject}`);
    }
    lines.push("", message.body || "(empty)", "");
  }
  return lines.join("\n");
}

function renderThreadListLine(thread: EmailThread, userEmail: string): string {
  const first = thread.messages[0];
  const last = thread.messages.at(-1);
  if (!first || !last) throw new Error(`Cannot index empty email thread ${thread.id}`);
  const people = collectThreadParticipants(thread, userEmail).slice(0, 3).join(", ") || "(only me)";
  return (
    `${thread.id} | ${first.day} → ${last.day} | ${thread.messages.length} msgs | ${people} | ` +
    sliceCharacters(first.subject.replaceAll("|", "/"), 70)
  );
}

function renderInboxListLine(row: MessageHeader, hasBody: boolean): string {
  return (
    `${row.threadId} | ${row.day} | ${row.fromEmail} | ` +
    `${looksLikeAHuman(row) ? "person" : "auto"} | ${row.count ?? 1} msgs | ` +
    `${sliceCharacters(row.subject.replaceAll("|", "/"), 70)} | ` +
    `${sliceCharacters(cleanSnippet(row.snippet ?? "").replaceAll("|", "/"), 140)} | ` +
    `${hasBody ? "body" : "header"}`
  );
}

function writeEvidenceIndex(
  evidenceDir: string,
  full: ReadonlyMap<string, string[]>,
  inbox: ReadonlyMap<string, string[]>,
): void {
  const threadYears = [...full.keys()].sort();
  const inboxYears = [...inbox.keys()].sort();
  const lines = [
    "# Evidence index",
    "",
    "Full-read threads (both sides, in `threads/<id>.md`):",
    ...[...threadYears].reverse().map((year) => `- threads-${year}.md — ${full.get(year)?.length ?? 0} threads`),
    "",
    "Transactions (typed rows parsed from automated mail: merchant, kind, amount): " +
      "transactions-<year>.md; aggregate them with search_memory scope=transactions.",
    "",
    "Skim-tier inbox threads (never extracted; rows marked body have raw messages in threads/<id>.md, " +
      "rows marked header need read_email):",
    ...[...inboxYears].reverse().map((year) => `- inbox-${year}.md — ${inbox.get(year)?.length ?? 0} threads`),
  ];
  writeFileAtomically(join(evidenceDir, "INDEX.md"), `${lines.join("\n")}\n`);
}

export function writeEvidenceFiles(
  threads: readonly EmailThread[],
  skimRows: readonly MessageHeader[],
  userEmail: string,
  root: string,
  bodyThreads: readonly EmailThread[] = [],
): EvidenceCounts {
  const paths = resolveBrainPaths(root);
  ensureDirectory(paths.evidenceDir);
  ensureDirectory(paths.evidenceThreadsDir);
  const writeRawThread = (thread: EmailThread): void =>
    writeFileAtomically(join(paths.evidenceThreadsDir, `${thread.id}.md`), renderThreadAsMarkdown(thread, userEmail));

  // Backfilled header-tier bodies: raw, searchable, citable, never extracted. Written first so a thread
  // that is also full-read keeps the full-read rendering.
  const bodies = bodyThreads.filter((thread) => thread.messages.length > 0);
  for (const thread of bodies) {
    writeRawThread(thread);
  }
  const hasBody = new Set(bodies.map((thread) => thread.id));

  const renderedThreads = threads.filter((thread) => thread.messages.length > 0);
  const byYear = new Map<string, string[]>();
  for (const thread of renderedThreads) {
    writeRawThread(thread);
    const last = thread.messages.at(-1);
    if (!last) continue;
    pushToYear(byYear, last.day.slice(0, 4), renderThreadListLine(thread, userEmail));
  }
  writeYearFiles(
    paths.evidenceDir,
    "threads",
    (year) => `# Full-read threads, ${year} (id | days | msgs | people | subject)`,
    byYear,
  );

  const inboxByYear = new Map<string, string[]>();
  const collapsed = collapseHeadersToThreads(skimRows);
  for (const row of collapsed) {
    pushToYear(inboxByYear, row.day.slice(0, 4), renderInboxListLine(row, hasBody.has(row.threadId)));
  }
  writeYearFiles(
    paths.evidenceDir,
    "inbox",
    (year) =>
      `# Skim-tier inbox threads, ${year}: not extracted; rows marked body have their raw messages in ` +
      "evidence/threads/<id>.md, rows marked header need read_email <id> " +
      "(id | day | from | person or auto sender | msgs | subject | body preview | body or header)",
    inboxByYear,
  );

  const transactions = writeTransactionFiles([...renderedThreads, ...bodies], paths.evidenceDir);
  writeEvidenceIndex(paths.evidenceDir, byYear, inboxByYear);
  return {
    threads: renderedThreads.length,
    messages: renderedThreads.reduce((total, thread) => total + thread.messages.length, 0),
    skimThreads: collapsed.length,
    bodyThreads: bodies.length,
    transactions,
  };
}

function renderTransactionRow(row: Transaction): string {
  const cell = (value: string): string => value.replaceAll("|", "/");
  return (
    `${row.threadId} | ${row.day} | ${cell(row.merchant)} | ${row.kind} | ${row.amount.toFixed(2)} | ` +
    `${row.currency} | ${cell(row.sender)} | ${cell(row.subject).slice(0, 70)}`
  );
}

export function writeTransactionFiles(threads: readonly EmailThread[], evidenceDir: string): number {
  ensureDirectory(evidenceDir);
  const rows = threads
    .flatMap((thread) => parseTransaction(thread) ?? [])
    .sort((a, b) => b.day.localeCompare(a.day) || a.threadId.localeCompare(b.threadId));
  const byYear = new Map<string, string[]>();
  for (const row of rows) {
    pushToYear(byYear, row.day.slice(0, 4), renderTransactionRow(row));
  }
  writeYearFiles(
    evidenceDir,
    "transactions",
    (year) =>
      `# Transactions, ${year}: parsed from automated mail at build time ` +
      "(id | day | merchant | kind | amount | currency | sender | subject)",
    byYear,
  );
  return rows.length;
}
