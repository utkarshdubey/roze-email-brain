// Days in the brain are the user's days at the time: their UTC offset is read off their own sent mail as a
// timeline, and every message is re-rendered into the offset nearest in time before anything downstream
// sees it, so headings, index rows, transactions, and citations agree.

import type { EmailMessage, EmailThread, MessageHeader } from "../types.js";

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MILLISECONDS_PER_DAY = 86_400_000;
const OFFSET = /([+-])(\d\d):(\d\d)$/u;

/** [timestamp in seconds, offset in minutes] where the user's offset changed; empty means UTC. */
export type OffsetTimeline = Array<[number, number]>;

/** Round-tripping through Date rejects days that only look valid, such as 2026-02-30. */
function convertCalendarDayToMilliseconds(value: string): number | undefined {
  const match = ISO_DAY.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1) return undefined;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date.getTime();
}

export function isCalendarDay(value: string): boolean {
  return convertCalendarDayToMilliseconds(value) !== undefined;
}

export function countDaysBetween(later: string, earlier: string): number {
  const laterMilliseconds = convertCalendarDayToMilliseconds(later);
  const earlierMilliseconds = convertCalendarDayToMilliseconds(earlier);
  if (laterMilliseconds === undefined || earlierMilliseconds === undefined)
    throw new Error(`countDaysBetween requires ISO calendar days; received ${later} and ${earlier}`);
  return (laterMilliseconds - earlierMilliseconds) / MILLISECONDS_PER_DAY;
}

export function loopIsStale(day: string, asOfDay = readCurrentCalendarDay()): boolean {
  return !isCalendarDay(day) || !isCalendarDay(asOfDay) || countDaysBetween(asOfDay, day) > 365;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

export function readCurrentCalendarDay(): string {
  const today = new Date();
  return `${pad(today.getFullYear(), 4)}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
}

export function offsetMinutesOf(isoDate: string): number | undefined {
  const match = OFFSET.exec(isoDate);
  if (!match) return undefined;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/** Every offset change across the user's own messages, oldest first; consecutive repeats collapse. */
export function buildOffsetTimeline(threads: readonly EmailThread[], userEmail: string): OffsetTimeline {
  const user = userEmail.trim().toLowerCase();
  const points: Array<[number, number]> = [];
  for (const thread of threads)
    for (const message of thread.messages)
      if (message.fromEmail.trim().toLowerCase() === user) {
        const offset = offsetMinutesOf(message.date);
        if (offset !== undefined) {
          points.push([message.timestamp, offset]);
        }
      }
  points.sort((a, b) => a[0] - b[0]);
  const timeline: OffsetTimeline = [];
  for (const point of points) {
    if (timeline.at(-1)?.[1] !== point[1]) {
      timeline.push(point);
    }
  }
  return timeline;
}

/** The offset of the user's own message nearest in time; UTC when the user has sent nothing. */
export function offsetAt(timeline: OffsetTimeline, timestampSeconds: number): number {
  if (!timeline.length) return 0;
  // Binary search for the last change at or before the timestamp; low lands on it.
  let low = 0;
  let high = timeline.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (timeline[mid]![0] <= timestampSeconds) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const before = timeline[low]!;
  const after = timeline[low + 1];
  // Mail older than the first change borrows that first offset; otherwise the nearer neighbour wins.
  if (before[0] > timestampSeconds) return before[1];
  if (after && after[0] - timestampSeconds < timestampSeconds - before[0]) return after[1];
  return before[1];
}

export function localDate(timestampSeconds: number, offsetMinutes: number): { date: string; day: string } {
  const local = new Date(timestampSeconds * 1_000 + offsetMinutes * 60_000);
  const two = (value: number): string => String(value).padStart(2, "0");
  const day = `${local.getUTCFullYear()}-${two(local.getUTCMonth() + 1)}-${two(local.getUTCDate())}`;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return {
    day,
    date:
      `${day}T${two(local.getUTCHours())}:${two(local.getUTCMinutes())}${sign}` +
      `${two(Math.floor(abs / 60))}:${two(abs % 60)}`,
  };
}

export function localizeThread(thread: EmailThread, timeline: OffsetTimeline): EmailThread {
  const messages = thread.messages.map((message: EmailMessage) => ({
    ...message,
    ...localDate(message.timestamp, offsetAt(timeline, message.timestamp)),
  }));
  return { ...thread, messages };
}

export function localizeHeader(row: MessageHeader, timeline: OffsetTimeline): MessageHeader {
  return { ...row, day: localDate(row.timestamp, offsetAt(timeline, row.timestamp)).day };
}
