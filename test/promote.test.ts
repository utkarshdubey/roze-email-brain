// Promotion-line tests keep the one paid prompt change, engagement evidence, cost estimate, and cumulative
// cache migration coupled: a future format edit must update all four together.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { senderAddressKey } from "../src/ingest/engagement.js";
import {
  decideWhatToReadPerSender,
  estimatePromotionCost,
  PROMOTION_SENDER_LINE_FORMAT_VERSION,
  readPromotionDecisions,
  type PromotionEngagement,
} from "../src/ingest/promote.js";
import { readJson, writeDataAtomically } from "../src/shared/atomicFiles.js";
import type { MessageHeader } from "../src/types.js";
import { context } from "./helpers.js";

function header(sender: string, threadId: string, timestamp: number, day: string): MessageHeader {
  return {
    id: `message-${threadId}`,
    threadId,
    timestamp,
    day,
    fromName: "Sender",
    fromEmail: sender,
    subject: `Subject ${threadId}`,
    labels: [],
    listId: "",
    snippet: "",
  };
}

test("promotion lines carry user engagement and cost estimation uses the same payload", async () => {
  const root = mkdtempSync(join(tmpdir(), "roze-promote-engagement-"));
  try {
    const sender = "signal@example.test";
    const rows = [
      header(sender, "older", 1, "2026-08-01"),
      header(sender, "newer", 2, "2026-08-02"),
    ];
    const engagement: PromotionEngagement = {
      threads: 12,
      opened: 3,
      replied: 4,
      important: 1,
      starred: 2,
    };
    const engagementBySender = new Map([[senderAddressKey(` ${sender.toUpperCase()} `), engagement]]);
    let system = "";
    let user = "";
    const ctx = context(root, {});
    ctx.callModel = (async (request) => {
      system = request.system;
      user = request.user;
      return request.schema.parse({ decisions: [{ sender, read: "ignore" }] });
    }) as typeof ctx.callModel;

    const estimate = estimatePromotionCost(rows, ctx, engagementBySender);
    assert.deepEqual(await decideWhatToReadPerSender(rows, ctx, engagementBySender), []);
    assert.equal(
      user,
      `${sender} | 2 threads | latest 2026-08-02 | Subject newer || Subject older | ` +
        "opened 3/12 | replied 4/12 | important 1 | starred 2",
    );
    assert.ok(
      system.includes(
        "Each sender line also shows how many threads the user opened, replied to, marked important, or starred;\n" +
          "these counts reflect the user's own behaviour.",
      ),
    );
    assert.equal(estimate.inputTokens, Math.trunc((system.length + user.length) / 4));
    assert.deepEqual(readJson(ctx.paths.cachedPromotionFile), {
      senderLineFormatVersion: PROMOTION_SENDER_LINE_FORMAT_VERSION,
      decisions: { [sender]: "ignore" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy decisions stay cumulative and keep their format warning until moved aside", async () => {
  const root = mkdtempSync(join(tmpdir(), "roze-promote-legacy-"));
  try {
    const cachedSender = "cached@example.test";
    const freshSender = "fresh@example.test";
    const rows = [
      header(cachedSender, "cached", 1, "2026-08-01"),
      header(freshSender, "fresh", 2, "2026-08-02"),
    ];
    const initial = context(root, {});
    writeDataAtomically(initial.paths.cachedPromotionFile, { [cachedSender]: "latest" });
    const warnings: string[] = [];
    const ctx = context(root, {}, (stage, done) => {
      if (done === undefined) warnings.push(stage);
    });
    ctx.callModel = (async (request) =>
      request.schema.parse({ decisions: [{ sender: freshSender, read: "ignore" }] })) as typeof ctx.callModel;

    assert.equal(estimatePromotionCost(rows, ctx).calls, 1);
    assert.deepEqual(await decideWhatToReadPerSender(rows, ctx), ["cached"]);
    assert.equal(warnings.length, 1, "the estimate and execution share one warning in a generation context");
    assert.match(warnings[0]!, /sender-line format is unversioned .*expected version 2.*Move .* aside/u);
    assert.deepEqual(readJson(ctx.paths.cachedPromotionFile), {
      senderLineFormatVersion: 1,
      decisions: {
        [cachedSender]: "latest",
        [freshSender]: "ignore",
      },
    });

    const nextWarnings: string[] = [];
    const next = context(root, {}, (stage, done) => {
      if (done === undefined) nextWarnings.push(stage);
    });
    assert.equal(estimatePromotionCost(rows, next).calls, 0);
    assert.match(nextWarnings[0]!, /sender-line format is version 1.*expected version 2.*Move .* aside/u);
    assert.deepEqual(readPromotionDecisions(next.paths, () => undefined), {
      [cachedSender]: "latest",
      [freshSender]: "ignore",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
