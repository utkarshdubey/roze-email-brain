import assert from "node:assert/strict";
import test from "node:test";

import { EntityRegistry } from "../src/memory/resolveEntities.js";
import type { MemoryItem, Mention, ThreadExtraction } from "../src/types.js";

const mention = (name: string, email: string, org: string, kind: Mention["kind"] = "person"): Mention => ({
  name,
  email,
  org,
  kind,
  role: "",
});
function row(
  threadId: string,
  day: string,
  mentions: Mention[],
  items: MemoryItem[] = [],
  state: ThreadExtraction["state"] = "none",
): ThreadExtraction {
  return {
    threadId,
    firstDay: day,
    lastDay: day,
    messageDays: [day],
    userStarted: false,
    summary: "Example.",
    state,
    stateNote: state === "resolved" ? "done" : "",
    mentions,
    items,
  };
}
const fact = (entity: string, entityType: string, date: string, text: string): MemoryItem => ({
  entity,
  entityType,
  date,
  text,
  kind: "fact",
  loopStatus: "",
});

test("shared addresses stay separate while first-name aliases merge only inside one organization", () => {
  const registry = new EntityRegistry("owner@example.com");
  const alice = registry.resolveEntityForMention(mention("Alice Person", "relay@example.com", "Example Energy LLC"));
  const bob = registry.resolveEntityForMention(mention("Bob Person", "relay@example.com", "Example Energy LLC"));
  assert.equal(registry.resolveEntityForMention(mention("Alice", "", "Example Energy")), alice);
  assert.notEqual(alice, bob);
  assert.equal(registry.uniqueEntityForEmail("relay@example.com"), undefined);
  assert.ok(
    registry
      .listEntities()
      .find((entity) => entity.slug === alice)
      ?.mergeCandidates.includes(bob!),
  );
});

test("organizations are materialized and loose items choose a whole-name match or primary label", () => {
  const registry = EntityRegistry.fromExtractions(
    [
      row(
        "one",
        "2026-01-01",
        [mention("Alice Person", "alice@example.com", "Example Co")],
        [
          fact("Launch decision", "project", "2026-01-01", "The launch was approved."),
          fact("Hiring", "project", "2026-01-01", "Alice Person approved the hiring plan."),
        ],
      ),
    ],
    "owner@example.com",
  );
  const entities = registry.listEntities();
  assert.equal(entities.find((entity) => entity.name === "Alice Person")?.items[0]?.label, "");
  assert.equal(entities.find((entity) => entity.name === "Example Co")?.items[0]?.label, "Launch decision");

  const isolated = EntityRegistry.fromExtractions(
    [
      row("known", "2026-01-01", [mention("Figma", "", "", "organization")]),
      row(
        "isolated",
        "2026-01-02",
        [],
        [fact("szn", "organization", "2026-01-02", "A Figma invitation came from szn.")],
      ),
    ],
    "owner@example.com",
  ).listEntities();
  assert.equal(isolated.find((entity) => entity.name === "Figma")?.items.length, 0);
  assert.equal(isolated.find((entity) => entity.name === "szn")?.items.length, 1);
});

test("the owner never becomes a contact; unsupported dates are counted and resolved threads close loops", () => {
  const source = row(
    "self",
    "2026-05-10",
    [
      mention("Mailbox Owner", "owner@example.com", ""),
      mention("Mailbox Owner", "", ""),
      mention("Example Co", "", "", "organization"),
    ],
    [
      fact("Mailbox Owner", "person", "2026-05-10", "I sent the document."),
      fact("Example Co", "organization", "2026-05-09", "Unsupported historical date."),
      {
        entity: "Example Co",
        entityType: "organization",
        date: "2026-05-10",
        text: "Example Co should reply.",
        kind: "loop",
        loopStatus: "open",
      },
    ],
    "resolved",
  );
  const registry = EntityRegistry.fromExtractions([source], "owner@example.com");
  assert.equal(registry.uniqueEntityForName("Mailbox Owner", "person"), undefined);
  assert.equal(registry.invalidDateItemsSkipped, 1);
  assert.equal(registry.selfPersonItemsRehomed, 1);
  const company = registry.listEntities().find((entity) => entity.name === "Example Co")!;
  assert.equal(company.items.find((item) => item.kind === "loop")?.loopStatus, "resolved: done");
});

test("loops whose every named date has passed leave the current index", async () => {
  const { findMentionedDays, loopDatesHavePassed } = await import("../src/memory/openLoops.js");
  assert.deepEqual(findMentionedDays("Interview on 6 Jul 2026, 12:00 ET; forms due 2026-07-20; call Sep 23, 2025"), [
    "2025-09-23",
    "2026-07-06",
    "2026-07-20",
  ]);
  assert.deepEqual(findMentionedDays("Trial ends next Tuesday"), []);
  assert.equal(loopDatesHavePassed("Interview invitation for 6 Jul 2026", "2026-09-02"), true);
  assert.equal(
    loopDatesHavePassed("Trial ends Sep 1, 2026 with payment on 2026-09-08", "2026-09-02"),
    false,
    "one future date keeps it open",
  );
  assert.equal(loopDatesHavePassed("Waiting on Mark to confirm", "2026-09-02"), false, "no date means no expiry");
});

test("inbox-only loops survive only when something is asked of the user", async () => {
  const { loopIsMaterial } = await import("../src/memory/openLoops.js");
  assert.equal(
    loopIsMaterial("Standard transfer initiated for $41.60; ETA 2026-09-02 to Chase.", false, false),
    false,
    "a transfer notice is a fact",
  );
  assert.equal(
    loopIsMaterial("Uncategorized transaction alert requesting categorization of a $50.00 transaction.", false, false),
    false,
  );
  assert.equal(
    loopIsMaterial("Trial ends Sep 1, 2026; next payment of $19.99 on Sep 1 if not canceled.", false, false),
    true,
    "a cancel-by decision is a loop",
  );
  assert.equal(loopIsMaterial("Password reset deadline of 2026-05-04.", false, false), true);
  assert.equal(
    loopIsMaterial("USCIS sent a secure verification code 748965 for login; no user reply in thread.", false, false),
    false,
    "codes are never loops",
  );
  assert.equal(
    loopIsMaterial("Interview invitation for 6 Jul 2026.", true, false),
    true,
    "relationships the user participates in keep their loops",
  );
});
