// Thread-level Gmail labels and participation become a deterministic per-sender engagement signal. Rows are
// collapsed to their opening header per thread, sender addresses use Gmail's trim/lowercase convention, and
// score = (4 × replied share + 2 × starred share + 2 × important share + opened share + kept-in-inbox
// share) / 10, so replies carry the most weight and the result is always in [0, 1].

import type { MessageHeader } from "../types.js";

export interface SenderEngagement {
  threads: number;
  opened: number;
  openedShare: number;
  important: number;
  importantShare: number;
  starred: number;
  keptInInbox: number;
  keptInInboxShare: number;
  archived: number;
  replied: number;
  repliedShare: number;
  lastDay: string;
  score: number;
}

interface SenderCounts {
  threads: number;
  opened: number;
  important: number;
  starred: number;
  keptInInbox: number;
  replied: number;
  lastDay: string;
  lastTimestamp: number;
}

/** Cached Gmail addresses are already lower-case; trimming also makes hand-built and legacy rows equivalent. */
export function senderAddressKey(address: string): string {
  return address.trim().toLowerCase();
}

function openingHeaders(rows: readonly MessageHeader[]): MessageHeader[] {
  const firstByThread = new Map<string, MessageHeader>();
  for (const row of rows) {
    const prior = firstByThread.get(row.threadId);
    if (
      !prior ||
      row.timestamp < prior.timestamp ||
      (row.timestamp === prior.timestamp && row.id.localeCompare(prior.id) < 0)
    ) {
      firstByThread.set(row.threadId, row);
    }
  }
  return [...firstByThread.values()];
}

function finish(counts: SenderCounts): SenderEngagement {
  const openedShare = counts.opened / counts.threads;
  const importantShare = counts.important / counts.threads;
  const starredShare = counts.starred / counts.threads;
  const keptInInboxShare = counts.keptInInbox / counts.threads;
  const repliedShare = counts.replied / counts.threads;
  const score =
    (4 * repliedShare + 2 * starredShare + 2 * importantShare + openedShare + keptInInboxShare) / 10;
  return {
    threads: counts.threads,
    opened: counts.opened,
    openedShare,
    important: counts.important,
    importantShare,
    starred: counts.starred,
    keptInInbox: counts.keptInInbox,
    keptInInboxShare,
    archived: counts.threads - counts.keptInInbox,
    replied: counts.replied,
    repliedShare,
    lastDay: counts.lastDay,
    score: Math.min(1, Math.max(0, score)),
  };
}

/** One thread belongs to its opening sender, matching the sender groups used for promotion. */
export function computeSenderEngagement(
  rows: readonly MessageHeader[],
  participatedThreadIds: ReadonlySet<string>,
): Map<string, SenderEngagement> {
  const countsBySender = new Map<string, SenderCounts>();
  for (const row of openingHeaders(rows)) {
    const sender = senderAddressKey(row.fromEmail);
    const counts = countsBySender.get(sender) ?? {
      threads: 0,
      opened: 0,
      important: 0,
      starred: 0,
      keptInInbox: 0,
      replied: 0,
      lastDay: "",
      lastTimestamp: Number.NEGATIVE_INFINITY,
    };
    counts.threads += 1;
    counts.opened += Number(!row.labels.includes("UNREAD"));
    counts.important += Number(row.labels.includes("IMPORTANT"));
    counts.starred += Number(row.labels.includes("STARRED"));
    counts.keptInInbox += Number(row.labels.includes("INBOX"));
    counts.replied += Number(participatedThreadIds.has(row.threadId));
    if (row.timestamp > counts.lastTimestamp || (row.timestamp === counts.lastTimestamp && row.day > counts.lastDay)) {
      counts.lastDay = row.day;
      counts.lastTimestamp = row.timestamp;
    }
    countsBySender.set(sender, counts);
  }
  return new Map(
    [...countsBySender]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sender, counts]) => [sender, finish(counts)]),
  );
}

/** Engagement leads, then the newest opening header, with the thread id as a stable final tie-breaker. */
export function orderThreadIdsBySenderEngagement(
  threadIds: readonly string[],
  rows: readonly MessageHeader[],
  engagementBySender: ReadonlyMap<string, SenderEngagement>,
): string[] {
  const headerByThread = new Map(openingHeaders(rows).map((row) => [row.threadId, row]));
  const score = (threadId: string): number => {
    const sender = headerByThread.get(threadId)?.fromEmail ?? "";
    return engagementBySender.get(senderAddressKey(sender))?.score ?? 0;
  };
  const timestamp = (threadId: string): number =>
    headerByThread.get(threadId)?.timestamp ?? Number.NEGATIVE_INFINITY;
  return [...new Set(threadIds)].sort(
    (left, right) =>
      score(right) - score(left) || timestamp(right) - timestamp(left) || left.localeCompare(right),
  );
}
