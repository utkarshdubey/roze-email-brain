// The open-loop lifecycle: which extracted items may stay "open", and which of those the current index
// still shows. Every rule here is deterministic; no model gets a say.
import { countDaysBetween, isCalendarDay, loopIsStale, readCurrentCalendarDay } from "../shared/dates.js";
import type { Entity, MemoryItem, OpenLoopRow, ThreadExtraction } from "../types.js";

/** Codes and sign-in notices are never loops, whatever the extractor wrote about replies. */
const SECURITY_NOTICE = /\b(verification code|one-time (code|passcode)|passkey|sign-in|login|2-step|two-factor)\b/iu;

/** Words that ask something of the user; a notice reporting a date or an amount is a fact, not a loop. */
const ACTION = new RegExp(
  String.raw`\b(action (needed|required)|due( by| on| date)?|deadline|expir(es?|ing|y)|respond|reply|` +
    String.raw`confirm|renew|cancel(l?ed|s)?|pay(ment)? (is )?(due|by|before)|submit|` +
    String.raw`complete (your|the)|verify|schedule|rsvp|before (\d|[a-z]+ \d)|waiting (on|for) you|` +
    String.raw`your (turn|move)|please (review|sign|upload|provide|send|complete|confirm)|must|` +
    String.raw`need(s)? to|required)\b`,
  "iu",
);

/**
 * An inbox-only loop survives only when something is asked of the user, or it belongs to a relationship
 * the user participates in. Receipts, transfers, and alerts that merely report a date or amount are facts.
 */
export function loopIsMaterial(
  text: string,
  entityAppearsInParticipatedThread: boolean,
  userStartedThread: boolean,
): boolean {
  return !SECURITY_NOTICE.test(text) && (userStartedThread || entityAppearsInParticipatedThread || ACTION.test(text));
}

/** An extractor-authored open loop cannot survive a thread that has already ended. */
export function closeLoopsWhoseThreadResolved(
  item: MemoryItem,
  thread: Pick<ThreadExtraction, "state" | "stateNote">,
): MemoryItem {
  if (item.kind !== "loop" || !item.loopStatus.startsWith("open") || thread.state === "open") return item;
  const loopStatus =
    thread.state === "resolved" ? `resolved: ${thread.stateNote || "thread ended"}` : "resolved: superseded";
  return { ...item, loopStatus };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ISO_DATE = /\b(20\d\d)-(\d\d)-(\d\d)\b/gu;
const DAY_MONTH_YEAR = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(20\d\d)\b/giu;
const MONTH_DAY_YEAR =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d\d)\b/giu;

const padNumber = (value: string): string => value.padStart(2, "0");

const monthNumber = (name: string): string => padNumber(String(MONTHS.indexOf(name.toLowerCase()) + 1));

export function findMentionedDays(text: string): string[] {
  const days = new Set<string>();
  for (const match of text.matchAll(ISO_DATE)) {
    days.add(`${match[1]}-${match[2]}-${match[3]}`);
  }
  for (const match of text.matchAll(DAY_MONTH_YEAR)) {
    days.add(`${match[3]}-${monthNumber(match[2]!)}-${padNumber(match[1]!)}`);
  }
  for (const match of text.matchAll(MONTH_DAY_YEAR)) {
    days.add(`${match[3]}-${monthNumber(match[1]!)}-${padNumber(match[2]!)}`);
  }
  return [...days].filter(isCalendarDay).sort();
}

/**
 * An invitation for July is not open in September: a loop whose every named day is more than a week past
 * leaves the current index, though the entity file keeps it with its extracted status.
 */
export function loopDatesHavePassed(text: string, asOfDay = readCurrentCalendarDay()): boolean {
  const days = findMentionedDays(text);
  return days.length > 0 && days.every((day) => countDaysBetween(asOfDay, day) > 7);
}

export function listOpenLoops(entities: readonly Entity[], asOfDay: string): OpenLoopRow[] {
  const rows: OpenLoopRow[] = [];
  for (const entity of entities) {
    const path = `${entity.type === "person" ? "people" : "organizations"}/${entity.slug}.md`;
    for (const item of entity.items) {
      if (
        item.kind !== "loop" ||
        !item.loopStatus.startsWith("open") ||
        loopIsStale(item.day, asOfDay) ||
        loopDatesHavePassed(item.text, asOfDay)
      )
        continue;
      const text = item.label ? `[${item.label}] ${item.text}` : item.text;
      rows.push({ entity: entity.name, path, text, threadId: item.threadId, day: item.day });
    }
  }
  return rows.sort((left, right) => right.day.localeCompare(left.day));
}
