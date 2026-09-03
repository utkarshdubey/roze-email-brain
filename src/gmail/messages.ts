// The Gmail wire format translated into EmailMessage: MIME body selection (plain text preferred, HTML
// flattened), quoted-reply trimming, address parsing, sender-local dates. The only place that knows it.

import { z } from "zod";
import { localDate } from "../shared/dates.js";
import type { EmailMessage } from "../types.js";

/** Bodies are capped so one newsletter cannot dominate an extraction prompt. */
export const MAX_BODY_CHARS = 3_000;

interface GmailHeaderResource {
  name: string;
  value: string;
}
interface GmailMessagePartResource {
  mimeType?: string;
  headers?: GmailHeaderResource[];
  body?: { data?: string | null };
  parts?: GmailMessagePartResource[] | null;
}
export interface GmailMessageResource {
  id: string;
  threadId?: string;
  internalDate?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailMessagePartResource;
}

const headerSchema = z.object({ name: z.string(), value: z.string() });
const partSchema: z.ZodType<GmailMessagePartResource> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    headers: z.array(headerSchema).optional(),
    body: z.object({ data: z.string().nullable().optional() }).optional(),
    parts: z.array(partSchema).nullable().optional(),
  }),
);
export const gmailMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
  internalDate: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  payload: partSchema.optional(),
});

const ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  bull: "•",
  copy: "©",
  gt: ">",
  hellip: "…",
  laquo: "«",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  nbsp: "\u00a0",
  ndash: "–",
  quot: '"',
  raquo: "»",
  rdquo: "”",
  reg: "®",
  rsquo: "’",
  trade: "™",
};

/** Zones Date.parse does not understand, in minutes east of UTC. */
const ZONE_OFFSETS: Record<string, number> = {
  UT: 0,
  UTC: 0,
  GMT: 0,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
};

function decodeEntities(text: string): string {
  return text.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/giu, (source, entity: string) => {
    if (!entity.startsWith("#")) return ENTITIES[entity.toLowerCase()] ?? source;
    const hexadecimal = entity[1]?.toLowerCase() === "x";
    const point = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isFinite(point) || point < 0 || point > 0x10ffff) return source;
    try {
      return String.fromCodePoint(point);
    } catch {
      return source;
    }
  });
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
      .replace(/<br\s*\/?>|<\/(?:p|div|tr|li)\s*>/giu, "\n")
      .replace(/<[^>]+>/gu, " "),
  );
}

/** Drops quoted history so a long reply chain is stored once, then caps the result by code point. */
export function cleanMessageBody(source: string): string {
  const lines: string[] = [];
  for (const line of source.split(/\r\n?|\n/u)) {
    const value = line.trim();
    if (value.startsWith(">")) continue;
    if (/^On .+ wrote:$/u.test(value) || value.startsWith("-----Original Message")) break;
    lines.push(value);
  }
  const cleaned = lines
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
  const characters = Array.from(cleaned);
  if (characters.length <= MAX_BODY_CHARS) return cleaned;
  return `${characters.slice(0, MAX_BODY_CHARS).join("")} …[truncated]`;
}

function extractBody(payload: GmailMessagePartResource): string {
  const plain: string[] = [];
  const html: string[] = [];
  const visit = (part: GmailMessagePartResource): void => {
    const data = part.body?.data;
    if (data && part.mimeType === "text/plain") {
      plain.push(Buffer.from(data, "base64url").toString("utf8"));
    } else if (data && part.mimeType === "text/html") {
      html.push(Buffer.from(data, "base64url").toString("utf8"));
    }
    for (const child of part.parts ?? []) {
      visit(child);
    }
  };
  visit(payload);
  return cleanMessageBody(plain.length ? plain.join("\n") : htmlToText(html.join("\n")));
}

function timezoneOffset(header: string): number | undefined {
  const numeric = /([+-])(\d{2}):?(\d{2})(?:\s*\([^)]*\))?\s*$/u.exec(header);
  if (numeric) {
    const hours = Number(numeric[2]);
    const minutes = Number(numeric[3]);
    if (hours > 23 || minutes > 59) return undefined;
    return (numeric[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
  }
  const named = /\b(UT|UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT)\s*$/u.exec(header.toUpperCase())?.[1];
  return named === undefined ? undefined : ZONE_OFFSETS[named];
}

/** The sender's own wall clock; dates.ts later re-renders it in the user's own offset. */
function parseDate(header: string, internalDate?: string): { date: string; day: string } {
  if (header) {
    const offset = timezoneOffset(header);
    // A header without a zone is read as UTC rather than as this machine's local time.
    const parsed = Date.parse(offset === undefined ? `${header} GMT` : header);
    if (Number.isFinite(parsed)) return localDate(Math.trunc(parsed / 1_000), offset ?? 0);
  }
  const fallback = Number(internalDate);
  if (!Number.isFinite(fallback)) throw new Error("Gmail message has neither a valid Date header nor internalDate");
  return localDate(Math.trunc(fallback / 1_000), 0);
}

function parseAddress(value: string): { name: string; email: string } {
  const angle = /^(.*)<([^<>]+)>\s*$/u.exec(value.trim());
  if (angle) {
    const display = (angle[1] ?? "").trim();
    const quoted = display.startsWith('"') && display.endsWith('"');
    const name = quoted ? display.slice(1, -1).replace(/\\(["\\])/gu, "$1") : display;
    return { name, email: (angle[2] ?? "").trim().toLowerCase() };
  }
  const found = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/iu.exec(value);
  if (!found) return { name: value.trim(), email: "" };
  const name = `${value.slice(0, found.index)}${value.slice(found.index + found[0].length)}`
    .trim()
    .replace(/^\(|\)$/gu, "")
    .trim();
  return { name, email: found[0].toLowerCase() };
}

export function parseMessage(message: GmailMessageResource, withBody = true): EmailMessage {
  if (!message.id) throw new Error("Gmail message is missing its id");
  const headers: Record<string, string> = Object.fromEntries(
    (message.payload?.headers ?? []).map((header) => [header.name.toLowerCase(), header.value]),
  );
  const local = parseDate(headers.date ?? "", message.internalDate);
  const sender = parseAddress(headers.from ?? "");
  const internalDate = Number(message.internalDate ?? 0);
  if (!Number.isFinite(internalDate)) throw new Error(`Gmail message ${message.id} has an invalid internalDate`);
  return {
    id: message.id,
    threadId: message.threadId ?? "",
    date: local.date,
    day: local.day,
    timestamp: Math.trunc(internalDate / 1_000),
    fromName: sender.name,
    fromEmail: sender.email,
    to: headers.to ?? "",
    cc: headers.cc ?? "",
    subject: headers.subject ?? "(no subject)",
    labels: message.labelIds ?? [],
    listId: headers["list-id"] ?? "",
    snippet: message.snippet ?? "",
    body: withBody && message.payload ? extractBody(message.payload) : "",
  };
}
