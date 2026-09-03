import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveModelCacheFile, type CallModel, type CachedModelRequest } from "../src/llm/models.js";
import {
  buildExtractionRequest,
  estimateExtractionCost,
  extractMemoryFromAllThreads,
  extractMemoryFromThread,
  LITE_NOTE,
} from "../src/memory/extractThread.js";
import { ensureDirectory, writeDataAtomically } from "../src/shared/atomicFiles.js";
import { context, message, USER } from "./helpers.js";

function rawExtraction(items = 5): unknown {
  return {
    summary: " Alice sent   an update. ",
    state: "open",
    state_note: "waiting on owner",
    mentions: [{ name: "Alice Person", kind: "person", email: "ALICE@example.com", org: "Example Co", role: "lead" }],
    items: Array.from({ length: items }, (_, index) => ({
      entity: "Alice Person",
      entity_type: "person",
      date: "2026-08-28",
      text: `Item ${index + 1}.`,
      kind: "fact",
      loop_status: "",
    })),
  };
}

test("lite extraction truncates body input, caps items, and maps exact message-day provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "roze-extract-"));
  try {
    const source = { id: "thread-lite", messages: [message("thread-lite", "2026-08-28")] };
    source.messages[0]!.body = `${"x".repeat(1_500)}DO-NOT-SEND`;
    let captured: CachedModelRequest<unknown> | undefined;
    const ctx = context(root, {});
    const fake: CallModel = async (request) => {
      captured = request as CachedModelRequest<unknown>;
      return request.schema.parse(rawExtraction());
    };
    ctx.callModel = fake;
    const result = await extractMemoryFromThread(source, USER, ctx);
    assert.equal(result.items.length, 4);
    assert.deepEqual(result.messageDays, ["2026-08-28"]);
    assert.equal(result.mentions[0]?.email, "alice@example.com");
    assert.ok(captured?.user.endsWith(LITE_NOTE));
    assert.doesNotMatch(captured?.user ?? "", /DO-NOT-SEND/u);
    assert.match(
      captured?.system ?? "",
      /Today is 2026-08-28/u,
      "the as-of day is the thread's own last message day, so caches survive the calendar",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cached extraction is reused without a call and makes the expected cost zero", async () => {
  const root = mkdtempSync(join(tmpdir(), "roze-extract-cache-"));
  try {
    const source = { id: "cached-thread", messages: [message("cached-thread", "2026-08-28", USER)] };
    const ctx = context(root, () => {
      throw new Error("cache missed");
    });
    ensureDirectory(ctx.paths.cachedExtractionsDir);
    writeDataAtomically(resolveModelCacheFile(buildExtractionRequest(source, USER, ctx)), {
      summary: "Cached.",
      state: "none",
      state_note: "",
      mentions: [],
      items: [],
    });
    assert.equal((await extractMemoryFromThread(source, USER, ctx)).summary, "Cached.");
    assert.deepEqual(estimateExtractionCost([source], USER, ctx), {
      calls: 0,
      items: 0,
      cached: 1,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      model: estimateExtractionCost([source], USER, ctx).model,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("batch extraction uses sixteen workers and preserves source order", async () => {
  const root = mkdtempSync(join(tmpdir(), "roze-extract-workers-"));
  try {
    const sources = Array.from({ length: 20 }, (_, index) => ({
      id: `t-${index}`,
      messages: [message(`t-${index}`, "2026-08-28", USER)],
    }));
    let active = 0;
    let maximum = 0;
    const ctx = context(root, {});
    ctx.callModel = async (request) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return request.schema.parse(rawExtraction(1));
    };
    const result = await extractMemoryFromAllThreads(sources, USER, ctx);
    assert.equal(maximum, 16);
    assert.deepEqual(
      result.map((row) => row.threadId),
      sources.map((row) => row.id),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a thread the model cannot process is skipped with a warning instead of aborting the build", async () => {
  const root = mkdtempSync(join(tmpdir(), "roze-extract-skip-"));
  try {
    const sources = ["a", "b", "c"].map((id) => ({
      id: `t-${id}`,
      messages: [message(`t-${id}`, "2026-08-28", USER)],
    }));
    const logs: string[] = [];
    const ctx = context(root, {}, (stage) => {
      logs.push(stage);
    });
    ctx.callModel = async (request) => {
      if (request.user.includes("t-b")) throw new Error("OpenAI request failed (400): context_length_exceeded");
      return request.schema.parse(rawExtraction(1));
    };
    const result = await extractMemoryFromAllThreads(sources, USER, ctx);
    assert.deepEqual(
      result.map((row) => row.threadId),
      ["t-a", "t-c"],
    );
    assert.ok(
      logs.some((line) => /warning: extraction skipped thread t-b: OpenAI request failed \(400\)/u.test(line)),
      logs.join("|"),
    );
    ctx.callModel = async () => {
      throw new Error("Model calls exceeded the shared 5000-call ceiling");
    };
    await assert.rejects(
      extractMemoryFromAllThreads([sources[1]!], USER, ctx),
      (error: unknown) => error instanceof AggregateError && /ceiling/u.test(error.errors[0]?.message ?? ""),
      "budget and ceiling errors still abort",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
