import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";

import {
  cachedModelCall,
  chooseReasoningEffort,
  PRICES,
  resetModelState,
  resolveModelCacheFile,
  usageLedger,
} from "../src/llm/models.js";
import { callProvider, type ProviderRequest } from "../src/llm/provider.js";

function wireResponse(text: string, outputTokens = 10): Response {
  return Response.json({
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 3 },
    },
  });
}
const request: ProviderRequest = {
  model: "gpt-5.4-mini",
  instructions: "system",
  input: "user",
  effort: "none",
  maxOutputTokens: 123,
  promptCacheKey: "cache-key",
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
  tools: [{ type: "function", name: "read", description: "Read", parameters: { type: "object" }, strict: true }],
  toolChoice: "auto",
};

test("provider sends the strict Responses shape and parses text, calls, and usage", async () => {
  const priorKey = process.env.OPENAI_API_KEY;
  const priorFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    let body: unknown;
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        output: [
          { type: "function_call", call_id: "c1", name: "read", arguments: '{"path":"x"}' },
          { type: "message", content: [{ type: "output_text", text: '{"ok":true}' }] },
        ],
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens: 4,
          output_tokens_details: { reasoning_tokens: 1 },
        },
      });
    };
    const result = await callProvider(request);
    assert.deepEqual(result.functionCalls, [{ callId: "c1", name: "read", argumentsJson: '{"path":"x"}' }]);
    assert.equal(result.outputText, '{"ok":true}');
    const sent = z
      .object({ reasoning: z.unknown(), text: z.unknown(), prompt_cache_key: z.string(), tool_choice: z.string() })
      .passthrough()
      .parse(body);
    assert.deepEqual(sent.reasoning, { effort: "none" });
    assert.deepEqual(sent.text, {
      format: { type: "json_schema", name: "brain", schema: request.schema, strict: true },
    });
    assert.equal(sent.prompt_cache_key, "cache-key");
    assert.equal(sent.tool_choice, "auto");
  } finally {
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
  }
});

test("provider retries 429 once but reports permanent 4xx without retrying", async () => {
  const priorKey = process.env.OPENAI_API_KEY;
  const priorFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    let calls = 0;
    globalThis.fetch = async () =>
      ++calls === 1
        ? new Response("busy", { status: 429, headers: { "retry-after": "0" } })
        : wireResponse('{"ok":true}');
    assert.equal((await callProvider(request)).outputText, '{"ok":true}');
    assert.equal(calls, 2);
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("bad key", { status: 401, statusText: "Unauthorized" });
    };
    await assert.rejects(callProvider(request), /401 Unauthorized.*bad key/u);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
  }
});

test("Zod JSON schemas are strict and model-family minimum effort uses the supported spelling", () => {
  const schema = z.object({ name: z.string(), count: z.number() }).strict();
  const json = z.toJSONSchema(schema, { target: "draft-07", io: "input" });
  assert.equal(json.additionalProperties, false);
  assert.deepEqual(json.required, ["name", "count"]);
  assert.equal(chooseReasoningEffort("gpt-5-nano", "minimal"), "minimal");
  for (const model of ["gpt-5.4-mini", "gpt-5.5", "gpt-5.6-nano"])
    assert.equal(chooseReasoningEffort(model, "minimal"), "none");
});

test("cached calls ignore schema in the key, parse once, quarantine rejects, and keep over-budget output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "roze-model-cache-"));
  const priorKey = process.env.OPENAI_API_KEY;
  const priorFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const schema = z.object({ ok: z.boolean() }).strict();
    const base = {
      kind: "test",
      system: "system",
      user: "user",
      schema,
      model: "gpt-5-nano",
      effort: "minimal" as const,
      cacheDir: directory,
    };
    assert.equal(
      resolveModelCacheFile(base),
      resolveModelCacheFile({ ...base, schema: z.object({ different: z.string() }) }),
    );
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return wireResponse('{"ok":true}');
    };
    resetModelState();
    assert.deepEqual(await cachedModelCall(base), { ok: true });
    assert.deepEqual(await cachedModelCall(base), { ok: true });
    assert.equal(calls, 1);
    const bad = { ...base, user: "bad" };
    globalThis.fetch = async () => wireResponse('{"ok":"wrong"}');
    await assert.rejects(cachedModelCall(bad), z.ZodError);
    assert.equal(readdirSync(join(directory, ".rejected")).length, 1);
    usageLedger.reset();
    const costly = { ...base, user: "costly", budget: 0 };
    globalThis.fetch = async () => wireResponse('{"ok":true}', 1_000_000);
    await assert.rejects(cachedModelCall(costly), /Actual model spend.*crossed --budget/u);
    assert.ok(existsSync(resolveModelCacheFile(costly)), "paid output is cached before the loud stop");
    let callsAfterBreach = 0;
    globalThis.fetch = async () => {
      callsAfterBreach += 1;
      return wireResponse('{"ok":true}');
    };
    await assert.rejects(
      cachedModelCall({ ...base, user: "queued", budget: 0 }),
      /Actual model spend.*crossed --budget/u,
    );
    assert.equal(callsAfterBreach, 0, "queued work cannot start a paid request after the ledger crosses budget");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
  }
});

test("the one usage ledger separates cached tokens and uses the model table", () => {
  usageLedger.reset();
  usageLedger.record({ inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, reasoningTokens: 3 }, "gpt-5-nano");
  assert.deepEqual(usageLedger.total(), {
    calls: 1,
    inputTokens: 80,
    cachedInputTokens: 20,
    outputTokens: 10,
    reasoningTokens: 3,
    usd:
      (80 * PRICES["gpt-5-nano"]!.input + 20 * PRICES["gpt-5-nano"]!.cached + 10 * PRICES["gpt-5-nano"]!.output) /
      1_000_000,
  });
});

test("a response that spent its whole output cap reasoning is retried once at low effort", async () => {
  const root = mkdtempSync(join(tmpdir(), "roze-loop-"));
  const efforts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    efforts.push(JSON.parse(String(init?.body)).reasoning.effort);
    return efforts.length === 1
      ? Response.json({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
          usage: { input_tokens: 5, output_tokens: 8000, output_tokens_details: { reasoning_tokens: 8000 } },
        })
      : wireResponse('{"ok":true}');
  };
  try {
    process.env.OPENAI_API_KEY = "test";
    const value = await cachedModelCall({
      kind: "judge",
      system: "s",
      user: "u",
      schema: z.object({ ok: z.boolean() }).strict(),
      model: "gpt-5.4-mini",
      effort: "medium",
      cacheDir: root,
    });
    assert.deepEqual(value, { ok: true });
    assert.deepEqual(efforts, ["medium", "low"]);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
