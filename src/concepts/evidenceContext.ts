// What the stored mail actually says, indexed once as an `EvidenceContext`, plus the checks both gate
// sets share. Every gate asks the same kind of question — is this claim visible in the mail the model was
// allowed to see? — and this module only makes that a cheap local lookup; it decides nothing.
import { z } from "zod";
import { isCalendarDay } from "../shared/dates.js";
import { cleanText, normalizeNameKey } from "../shared/text.js";
import {
  looksLikeAHuman,
  reject,
  type EmailMessage,
  type EmailThread,
  type EvidenceRow,
  type RejectionCounts,
  type RelatedThread,
  type ThreadExtraction,
} from "../types.js";

/** Bulk mail never carries a state or an outcome: it is broadcast, not addressed to this user's case. */
const BULK_CATEGORY_LABELS = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS", "SPAM", "TRASH"]);
export const MAX_RELATED_ROWS = 15;

export interface EvidenceContext {
  /** Every day that heads a message, per thread: the only days a citation may name. */
  days: Record<string, Set<string>>;
  humanDays: Record<string, Set<string>>;
  /** Days that may carry a status or an outcome: human mail plus addressed automated mail. */
  stateDays: Record<string, Set<string>>;
  text: Record<string, string>;
  /** Threads the user wrote in anywhere; engagement counts the thread, not the cited day. */
  userThreads: Set<string>;
  extractions: Map<string, ThreadExtraction>;
  /** Person-name keys per thread, used to catch an "interest" that is really a person. */
  people: Record<string, Set<string>>;
  self: Set<string>;
  /** The newest day anywhere in the mail; "recent" is measured against this, never wall-clock time. */
  cutoff: string;
}

/** Addressed automated mail can carry a state (a case status, an ATS decision); bulk mail cannot. */
function daysThatCanCarryState(dated: readonly EmailMessage[], human: readonly EmailMessage[]): Set<string> {
  const addressed = dated.filter(
    (message) => !message.listId && !message.labels.some((label) => BULK_CATEGORY_LABELS.has(label)),
  );
  return new Set([...human, ...addressed].map((message) => message.day));
}
export function buildEvidenceContext(
  threads: readonly EmailThread[],
  extractions: readonly ThreadExtraction[],
  userEmail?: string,
): EvidenceContext {
  const days: Record<string, Set<string>> = {};
  const humanDays: Record<string, Set<string>> = {};
  const stateDays: Record<string, Set<string>> = {};
  const text: Record<string, string[]> = {};
  const user = userEmail?.trim().toLowerCase();
  const userThreads = new Set<string>();
  for (const thread of threads) {
    days[thread.id] = new Set(thread.messages.map((message) => message.day).filter(isCalendarDay));
    if (user && thread.messages.some((message) => message.fromEmail.toLowerCase() === user)) {
      userThreads.add(thread.id);
    }
    const dated = thread.messages.filter((message) => isCalendarDay(message.day));
    const human = dated.filter((message) => message.fromEmail.toLowerCase() === user || looksLikeAHuman(message));
    humanDays[thread.id] = new Set(human.map((message) => message.day));
    stateDays[thread.id] = daysThatCanCarryState(dated, human);
    text[thread.id] = thread.messages.map((message) => cleanText(message.subject, 200));
  }
  const people: Record<string, Set<string>> = {};
  const self = new Set<string>();
  for (const extraction of extractions) {
    const parts = text[extraction.threadId] ?? [];
    parts.push(cleanText(extraction.summary, 700), cleanText(extraction.stateNote, 350));
    for (const mention of extraction.mentions) {
      parts.push(cleanText(mention.name, 120), cleanText(mention.org, 120));
      if (mention.kind === "person") {
        (people[extraction.threadId] ??= new Set()).add(normalizeNameKey(mention.name));
      }
      if (user && mention.email.toLowerCase() === user) {
        self.add(normalizeNameKey(mention.name));
      }
    }
    for (const item of extraction.items) {
      parts.push(cleanText(item.entity, 120), cleanText(item.text, 500));
    }
    text[extraction.threadId] = parts;
  }
  return {
    days,
    humanDays,
    stateDays,
    text: Object.fromEntries(Object.entries(text).map(([id, parts]) => [id, parts.join(" ").toLowerCase()])),
    userThreads,
    extractions: new Map(extractions.map((row) => [row.threadId, row])),
    people,
    self,
    cutoff: newestDay(days),
  };
}
function newestDay(days: Record<string, Set<string>>): string {
  return (
    Object.values(days)
      .flatMap((value) => [...value])
      .sort()
      .at(-1) ?? ""
  );
}

// GROUNDING CHECKS — every one of these answers "does the mail support this?" for a single claim.

/**
 * Drops rows naming a day no message was sent on, repeating a (thread, day, role) triple, using an
 * unknown role, or carrying no reason. `allowed` is the scope shown, so a real but unseen thread fails.
 */
export function keepValidEvidence<Role extends string>(
  rows: readonly EvidenceRow<Role>[],
  allowed: Record<string, Set<string>>,
  roles: readonly string[],
) {
  const seen = new Set<string>();
  const evidence: EvidenceRow<Role>[] = [];
  let invalid = 0;
  for (const row of rows) {
    const clean = {
      threadId: row.threadId,
      day: row.day,
      reason: cleanText(row.reason),
      role: cleanText(row.role, 80) as Role,
    };
    const key = `${clean.threadId}\0${clean.day}\0${clean.role}`;
    const supported = isCalendarDay(clean.day) && allowed[clean.threadId]?.has(clean.day);
    if (seen.has(key) || !supported || !clean.reason || !roles.includes(clean.role)) {
      invalid += 1;
    } else {
      seen.add(key);
      evidence.push(clean);
    }
  }
  return { evidence, invalid };
}
export const dayHasHumanMessage = (context: EvidenceContext, row: { threadId: string; day: string }): boolean =>
  context.humanDays[row.threadId]?.has(row.day) ?? false;
export const dayCanCarryState = (context: EvidenceContext, row: { threadId: string; day: string }): boolean =>
  context.stateDays[row.threadId]?.has(row.day) ?? false;
/** The opening day of the earliest cited thread, not the earliest citation. */
export function firstMessageDay(context: EvidenceContext, evidence: readonly { threadId: string }[]): string {
  const openingDays = evidence
    .map((row) => [...(context.days[row.threadId] ?? [])].sort()[0] ?? "")
    .filter(Boolean)
    .sort();
  return openingDays[0] ?? "";
}
export function observedParties(
  context: EvidenceContext,
  evidence: readonly { threadId: string }[],
  kind: "person" | "organization",
): Set<string> {
  const observed = new Set<string>();
  for (const row of evidence)
    for (const mention of context.extractions.get(row.threadId)?.mentions ?? []) {
      if (mention.kind === kind) {
        observed.add(cleanText(mention.name, 160).toLowerCase());
      }
      if (kind === "organization") {
        observed.add(cleanText(mention.org, 160).toLowerCase());
      }
    }
  observed.delete("");
  return observed;
}
/** A narrative may only name years the cited evidence spans; anything else is dropped, the concept stays. */
export function keepGroundedNarrative(
  narrative: string,
  evidence: readonly { day: string }[],
  counts: RejectionCounts,
  name: string,
): string {
  const text = cleanText(narrative, 900);
  if (!text) return "";
  const years = evidence.map((row) => Number(row.day.slice(0, 4)));
  const low = Math.min(...years);
  const high = Math.max(...years);
  const mentioned = [...text.matchAll(/\b(19|20)\d\d\b/gu)].map((match) => Number(match[0]));
  if (mentioned.some((year) => year < low || year > high)) {
    reject(counts, name);
    return "";
  }
  return text;
}
export const relatedThreadSchema = z.object({ threadId: z.string(), day: z.string(), subject: z.string() }).strict();
/** A "see also" row must name a real day in a thread this concept has not already cited. */
export function keepValidRelated(
  rows: readonly RelatedThread[],
  context: EvidenceContext,
  cited: ReadonlySet<string>,
  counts: RejectionCounts,
  name: string,
): RelatedThread[] {
  const seen = new Set<string>();
  const kept: RelatedThread[] = [];
  for (const row of rows) {
    const subject = cleanText(row.subject, 90).trim();
    if (cited.has(row.threadId) || seen.has(row.threadId) || !context.days[row.threadId]?.has(row.day) || !subject) {
      reject(counts, name);
      continue;
    }
    seen.add(row.threadId);
    kept.push({ threadId: row.threadId, day: row.day, subject });
  }
  return kept.slice(0, MAX_RELATED_ROWS);
}
