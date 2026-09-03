import assert from "node:assert/strict";
import test from "node:test";

import { buildClusters } from "../src/concepts/buildClusters.js";
import { buildClusterJudgeBatches, buildJudgeRequest } from "../src/concepts/judgeClusters.js";
import { normalizeTopicLabel } from "../src/concepts/topicClusters.js";
import type { DomainTags, ThreadCard, ThreadCluster } from "../src/types.js";
import { USER } from "./helpers.js";

function card(threadId: string, day: string, subjects: string[] = []): ThreadCard {
  return {
    threadId,
    days: [day],
    userParticipated: true,
    userStarted: true,
    subjects,
    summary: "A concrete recurring effort.",
    state: "none",
    stateNote: "",
    mentions: [],
    items: [],
    firstDay: day,
    lastDay: day,
    engaged: true,
    substantive: true,
  };
}

function tagsFor(cards: readonly ThreadCard[], topics: readonly string[]): DomainTags {
  return Object.fromEntries(
    cards.map((row, index) => [row.threadId, { domains: [], topic: topics[index] ?? "" }]),
  );
}

test("topic labels normalize mail prefixes, punctuation, short tokens, and function words", () => {
  assert.equal(normalizeTopicLabel(" Re: FWD: The API for garden-planning! "), "api garden planning");
});

test("identical normalized topic labels cluster engaged threads without a shared entity or domain", () => {
  const cards = [card("topic00000000001", "2026-01-01"), card("topic00000000002", "2026-02-01")];
  const clusters = buildClusters(cards, tagsFor(cards, ["Re: Garden-planning!", "the garden planning"]));
  assert.deepEqual(
    clusters.filter((cluster) => cluster.kind === "topic"),
    [
      {
        key: "topic-garden-planning",
        anchor: "garden planning",
        aliases: [],
        kind: "topic",
        threadIds: cards.map((row) => row.threadId).reverse(),
      },
    ],
  );
});

test("subject vocabulary contributes to topic Jaccard overlap", () => {
  const cards = [
    card("subject000000001", "2026-01-01", ["Re: seedling schedule"]),
    card("subject000000002", "2026-02-01", ["FW: seedling schedule!"]),
  ];
  const topics = tagsFor(cards, ["garden layout", "garden irrigation"]);
  const clusters = buildClusters(cards, topics).filter((cluster) => cluster.kind === "topic");
  assert.equal(clusters.length, 1);
  assert.deepEqual(new Set(clusters[0]!.threadIds), new Set(cards.map((row) => row.threadId)));
});

test("topic Jaccard unions are deterministic and transitive", () => {
  const cards = [
    card("jaccard000000001", "2026-01-01"),
    card("jaccard000000002", "2026-02-01"),
    card("jaccard000000003", "2026-03-01"),
  ];
  const topics = tagsFor(cards, ["garden design planning", "garden design schedule", "design schedule milestones"]);
  const clusters = buildClusters(cards, topics).filter((cluster) => cluster.kind === "topic");
  assert.equal(clusters.length, 1);
  assert.deepEqual(new Set(clusters[0]!.threadIds), new Set(cards.map((row) => row.threadId)));
  assert.deepEqual(clusters[0]!.aliases, ["garden design planning", "garden design schedule"]);
  assert.deepEqual(buildClusters([...cards].reverse(), topics), buildClusters(cards, topics));
});

test("topic clusters use the entity engaged minimum, cap, and oversized year split", () => {
  const insufficient = [
    card("minimum00000001", "2026-01-01"),
    { ...card("minimum00000002", "2026-02-01"), engaged: false },
  ];
  assert.equal(
    buildClusters(insufficient, tagsFor(insufficient, ["community garden", "community garden"]))
      .filter((cluster) => cluster.kind === "topic").length,
    0,
  );

  const cards = Array.from({ length: 32 }, (_, index) =>
    card(`year${String(index).padStart(12, "0")}`, `${index < 2 ? 2021 : 2026}-06-01`),
  );
  const tags = tagsFor(cards, cards.map(() => "community garden planning"));
  const clusters = buildClusters(cards, tags).filter((cluster) => cluster.kind === "topic");
  assert.deepEqual(
    clusters.map((cluster) => [cluster.key, cluster.anchor, cluster.threadIds.length]),
    [
      ["topic-community-garden-planning-2026", "community garden planning 2026", 30],
      ["topic-community-garden-planning-2021", "community garden planning 2021", 2],
    ],
  );
  const smallCards = cards.slice(0, 10);
  const small = buildClusters(smallCards, tags).filter((cluster) => cluster.kind === "topic");
  assert.deepEqual(
    small.map((cluster) => [cluster.key, cluster.threadIds.length]),
    [["topic-community-garden-planning", 10]],
  );
});

test("topic buckets append without changing entity or domain judge cache inputs", () => {
  const cards = Array.from({ length: 30 }, (_, index) =>
    card(`batch${String(index).padStart(11, "0")}`, "2026-01-01"),
  );
  const tags = tagsFor(cards, cards.map(() => "shared planning effort"));
  const existing: ThreadCluster[] = Array.from({ length: 30 }, (_, index) => ({
    key: `${index % 2 ? "entity" : "domain"}-${index}`,
    anchor: `group ${index}`,
    aliases: [],
    kind: index % 2 ? "entity" : "domain",
    threadIds: [cards[index]!.threadId],
  }));
  const topics: ThreadCluster[] = Array.from({ length: 10 }, (_, index) => ({
    key: `topic-${index}`,
    anchor: `topic ${index}`,
    aliases: [],
    kind: "topic",
    threadIds: [cards[index]!.threadId],
  }));
  const before = buildClusterJudgeBatches(existing, cards, tags);
  const after = buildClusterJudgeBatches([topics[0]!, ...existing, ...topics.slice(1)], cards, tags);
  const existingAfter = after.filter((batch) => batch.every((cluster) => cluster.kind !== "topic"));
  const topicAfter = after.filter((batch) => batch.some((cluster) => cluster.kind === "topic"));
  assert.deepEqual(existingAfter, before);
  assert.ok(topicAfter.every((batch) => batch.every((cluster) => cluster.kind === "topic")));

  const cacheInput = (batch: readonly ThreadCluster[]) => {
    const { request } = buildJudgeRequest(batch, cards, tags, USER, "2026-09-03");
    return { kind: request.kind, model: request.model, system: request.system, user: request.user };
  };
  assert.deepEqual(existingAfter.map(cacheInput), before.map(cacheInput));
});
