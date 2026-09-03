// Adapts one Enron maildir inbox (the public CMU corpus) to the Gmail client interface, so generate can
// build a brain from public data. Threads are reconstructed by normalized subject: the corpus has no ids.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { GmailReader } from "../../src/ingest/mail.js";
import type { GmailProfile } from "../../src/gmail/client.js";
import { hashText } from "../../src/shared/text.js";
import { threadIncludesUser, type EmailMessage, type EmailThread, type MessageHeader } from "../../src/types.js";

const MAX_BODY_CHARS = 3_000;
const SUBJECT_PREFIX = /^\s*((re|fw|fwd)\s*:\s*)+/iu;
const OFFSET = /([+-])(\d\d)(\d\d)/u;

interface RawMessage {
  headers: Record<string, string>;
  body: string;
}

function parseRawMessage(text: string): RawMessage {
  const split = text.search(/\r?\n\r?\n/u);
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? "" : text.slice(split).replace(/^\r?\n\r?\n/u, "");
  const headers: Record<string, string> = {};
  let current = "";
  for (const line of head.split(/\r?\n/u)) {
    if (/^\s/u.test(line) && current) {
      headers[current] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    current = line.slice(0, colon).trim().toLowerCase();
    headers[current] = line.slice(colon + 1).trim();
  }
  return { headers, body };
}

export function normalizeSubject(subject: string): string {
  let value = subject.trim();
  for (;;) {
    const next = value.replace(SUBJECT_PREFIX, "");
    if (next === value) break;
    value = next;
  }
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

interface Address {
  name: string;
  email: string;
}

function parseAddress(value: string): Address {
  const email = (value.match(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+/u)?.[0] ?? "").toLowerCase();
  const name = value
    .replace(/<[^>]*>/gu, "")
    .replace(/"/gu, "")
    .replace(email, "")
    .trim();
  return { name, email };
}

interface SenderLocalDate {
  date: string;
  day: string;
  timestamp: number;
}

/** Sender-local timestamp and day from an RFC 822 Date header; the day is the citation coordinate. */
function parseDate(value: string): SenderLocalDate | undefined {
  const utc = Date.parse(value.replace(/\s*\([A-Z]+\)\s*$/u, ""));
  if (!Number.isFinite(utc)) return undefined;
  const offset = OFFSET.exec(value.replace(/\s*\([A-Z]+\)\s*$/u, "").slice(-6));
  const minutes = offset ? (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) : 0;
  const local = new Date(utc + minutes * 60_000).toISOString().slice(0, 19);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return {
    date: `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`,
    day: local.slice(0, 10),
    timestamp: Math.floor(utc / 1_000),
  };
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}

/** The corpus keeps sent mail in a handful of folder spellings; the owner is whoever sent the most of it. */
function isSentPath(relativePath: string): boolean {
  return /(^|\/)(_?sent(_items|_mail)?)\//u.test(`/${relativePath}`) || /^_?sent/u.test(relativePath);
}

function toMessage(id: string, raw: RawMessage, when: SenderLocalDate, from: Address): EmailMessage {
  const body = raw.body.replace(/\r/gu, "").trim().slice(0, MAX_BODY_CHARS);
  return {
    id,
    threadId: "",
    date: when.date,
    day: when.day,
    timestamp: when.timestamp,
    fromName: from.name,
    fromEmail: from.email,
    to: raw.headers.to ?? "",
    cc: raw.headers.cc ?? "",
    subject: (raw.headers.subject ?? "").replace(/\s+/gu, " ").trim(),
    labels: [],
    listId: "",
    snippet: body.replace(/\s+/gu, " ").slice(0, 160),
    body,
  };
}

interface ScannedMaildir {
  /** Deduplicated by message id: the corpus stores the same message under several folders. */
  messages: Map<string, EmailMessage>;
  sentCounts: Map<string, number>;
  /** Every file path, including the duplicates, so EnronQA rows can be mapped back to a thread. */
  idByPath: Map<string, string>;
}

function scanMaildir(userDirectory: string): ScannedMaildir {
  const messages = new Map<string, EmailMessage>();
  const sentCounts = new Map<string, number>();
  const idByPath = new Map<string, string>();
  for (const file of walk(userDirectory)) {
    const raw = parseRawMessage(readFileSync(file, "latin1"));
    const when = parseDate(raw.headers.date ?? "");
    const from = parseAddress(raw.headers.from ?? "");
    if (!when || !from.email) continue;
    const relativePath = relative(userDirectory, file).split(sep).join("/");
    const id = hashText(`enron-message\0${raw.headers["message-id"] ?? file}`).slice(0, 16);
    if (isSentPath(relativePath)) sentCounts.set(from.email, (sentCounts.get(from.email) ?? 0) + 1);
    idByPath.set(relativePath, id);
    if (!messages.has(id)) messages.set(id, toMessage(id, raw, when, from));
  }
  return { messages, sentCounts, idByPath };
}

export class EnronMaildirClient implements GmailReader {
  readonly userEmail: string;
  readonly latestDay: string;
  readonly #messages = new Map<string, EmailMessage>();
  readonly #threads = new Map<string, EmailThread>();
  readonly #threadByPath = new Map<string, string>();

  constructor(userDirectory: string, userEmail?: string) {
    const scan = scanMaildir(userDirectory);
    this.userEmail = userEmail ?? [...scan.sentCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    this.#groupIntoThreads(scan.messages);
    for (const [path, id] of scan.idByPath) {
      const message = this.#messages.get(id);
      if (message) this.#threadByPath.set(path, message.threadId);
    }
    this.latestDay = [...this.#messages.values()].reduce(
      (best, message) => (message.day > best ? message.day : best),
      "1970-01-01",
    );
  }

  /** One thread per normalized subject; short subjects stay single so generic mail does not merge. */
  #groupIntoThreads(messages: ReadonlyMap<string, EmailMessage>): void {
    for (const message of messages.values()) {
      const key = normalizeSubject(message.subject);
      const threadKey = key.length >= 6 && key.includes(" ") ? `subject\0${key}` : `message\0${message.id}`;
      const threadId = hashText(`enron-thread\0${threadKey}`).slice(0, 16);
      message.threadId = threadId;
      message.labels = [message.fromEmail === this.userEmail ? "SENT" : "INBOX"];
      const thread = this.#threads.get(threadId) ?? { id: threadId, messages: [] };
      thread.messages.push(message);
      this.#threads.set(threadId, thread);
      this.#messages.set(message.id, message);
    }
    for (const thread of this.#threads.values())
      thread.messages.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  }

  threadIdForPath(relativePath: string): string | undefined {
    return this.#threadByPath.get(relativePath);
  }
  get threadCount(): number {
    return this.#threads.size;
  }
  get messageCount(): number {
    return this.#messages.size;
  }
  #participated(thread: EmailThread): boolean {
    return threadIncludesUser(thread, this.userEmail);
  }

  async getProfile(): Promise<GmailProfile> {
    return {
      emailAddress: this.userEmail,
      messagesTotal: this.#messages.size,
      threadsTotal: this.#threads.size,
      historyId: "enron-maildir",
    };
  }
  async listThreadIds(query: string, limit = 100_000): Promise<string[]> {
    if (query.startsWith("is:starred")) return [];
    const threads = [...this.#threads.values()].filter(
      (thread) => !query.startsWith("in:sent") || this.#participated(thread),
    );
    return threads.map((thread) => thread.id).slice(0, limit);
  }
  /** Skim listings ignore Gmail query syntax: every message outside a participated thread, newest first. */
  async listMessageIds(_query: string, limit = 100_000): Promise<string[]> {
    return [...this.#messages.values()]
      .filter((message) => !this.#participated(this.#threads.get(message.threadId)!))
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((message) => message.id)
      .slice(0, limit);
  }
  async fetchThread(id: string): Promise<EmailThread> {
    const thread = this.#threads.get(id);
    if (!thread) throw new Error(`No Enron thread ${id}`);
    return { id, messages: thread.messages.map((message) => ({ ...message })) };
  }
  async fetchMessageHeaders(id: string): Promise<MessageHeader> {
    const message = this.#messages.get(id);
    if (!message) throw new Error(`No Enron message ${id}`);
    const { threadId, timestamp, day, fromName, fromEmail, subject, labels, listId, snippet } = message;
    return { id, threadId, timestamp, day, fromName, fromEmail, subject, labels, listId, snippet };
  }
}
