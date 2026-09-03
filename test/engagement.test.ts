import assert from "node:assert/strict";
import test from "node:test";

import {
  computeSenderEngagement,
  orderThreadIdsBySenderEngagement,
  senderAddressKey,
} from "../src/ingest/engagement.js";
import type { MessageHeader } from "../src/types.js";

function header(
  sender: string,
  threadId: string,
  timestamp: number,
  labels: string[],
  changes: Partial<MessageHeader> = {},
): MessageHeader {
  return {
    id: `${threadId}-${timestamp}`,
    threadId,
    timestamp,
    day: `2026-0${timestamp}-01`,
    fromName: "Sender",
    fromEmail: sender,
    subject: "Synthetic subject",
    labels,
    listId: "",
    ...changes,
  };
}

test("sender engagement combines Gmail behavior at thread level", () => {
  const rows = [
    header(" Alice@Example.COM ", "alice-read", 1, ["IMPORTANT", "STARRED", "INBOX"]),
    header("other@example.com", "alice-read", 2, [], { id: "later-message" }),
    header(" Alice@Example.COM ", "alice-read", 1, ["IMPORTANT", "STARRED", "INBOX"]),
    header("alice@example.com", "alice-unread", 2, ["UNREAD"]),
    header("bob@example.com", "bob-read", 3, ["IMPORTANT", "STARRED", "INBOX"]),
  ];
  const engagement = computeSenderEngagement(rows, new Set(["alice-read", "bob-read"]));

  assert.equal(senderAddressKey(" Alice@Example.COM "), "alice@example.com");
  assert.deepEqual([...engagement.keys()], ["alice@example.com", "bob@example.com"]);
  assert.deepEqual(engagement.get("alice@example.com"), {
    threads: 2,
    opened: 1,
    openedShare: 0.5,
    important: 1,
    importantShare: 0.5,
    starred: 1,
    keptInInbox: 1,
    keptInInboxShare: 0.5,
    archived: 1,
    replied: 1,
    repliedShare: 0.5,
    lastDay: "2026-02-01",
    score: 0.5,
  });
  assert.deepEqual(engagement.get("bob@example.com"), {
    threads: 1,
    opened: 1,
    openedShare: 1,
    important: 1,
    importantShare: 1,
    starred: 1,
    keptInInbox: 1,
    keptInInboxShare: 1,
    archived: 0,
    replied: 1,
    repliedShare: 1,
    lastDay: "2026-03-01",
    score: 1,
  });
  assert.equal(engagement.has("other@example.com"), false, "a thread belongs to its opening sender");
});

test("sender engagement is independent of cached row order", () => {
  const rows = [
    header("second@example.com", "second", 4, ["UNREAD", "INBOX"]),
    header("first@example.com", "first", 2, []),
    header("first@example.com", "first", 1, ["IMPORTANT"], { id: "opening" }),
  ];
  const participated = new Set<string>();

  assert.deepEqual(
    [...computeSenderEngagement(rows, participated)],
    [...computeSenderEngagement([...rows].reverse(), participated)],
  );
  for (const value of computeSenderEngagement(rows, participated).values()) {
    assert.ok(value.score >= 0 && value.score <= 1);
  }
});

test("body thread order favors engaged senders before recency and id", () => {
  const rows = [
    header("engaged@example.com", "replied", 1, ["IMPORTANT", "INBOX"]),
    header("engaged@example.com", "engaged-older", 3, ["INBOX"]),
    header("engaged@example.com", "engaged-newer", 4, ["INBOX"]),
    header("quiet@example.com", "quiet-newest", 9, ["UNREAD"]),
    header("quiet@example.com", "quiet-tie-b", 8, ["UNREAD"]),
    header("quiet@example.com", "quiet-tie-a", 8, ["UNREAD"]),
  ];
  const engagement = computeSenderEngagement(rows, new Set(["replied"]));

  assert.deepEqual(
    orderThreadIdsBySenderEngagement(
      ["quiet-tie-b", "quiet-newest", "engaged-older", "quiet-tie-a", "engaged-newer"],
      rows,
      engagement,
    ),
    ["engaged-newer", "engaged-older", "quiet-newest", "quiet-tie-a", "quiet-tie-b"],
  );
});
