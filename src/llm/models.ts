// The cost-and-cache boundary every stage calls through: it picks the effort spelling, memoizes answers on
// disk under a content hash, meters spend, and refuses work that would cross --budget.

import { chmodSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { ensureDirectory, loadEnvironmentFile, readJson, writeDataAtomically } from "../shared/atomicFiles.js";
import { hashText } from "../shared/text.js";
import type { ModelUsage } from "../types.js";
import { callProvider, type ProviderUsage, type ReasoningEffort } from "./provider.js";

// MODELS reads env defaults at import, so .env must already be loaded here.
loadEnvironmentFile();

export const MODELS = {
  // The one place a larger model measurably pays for itself (NOTES.md); about six cents a question.
  answer: process.env.ROZE_MODEL_ANSWER ?? "gpt-5.4",
  extract: process.env.ROZE_MODEL_EXTRACT ?? "gpt-5-nano",
  // Promotion is one call per batch of senders, so the mini model still costs cents per build.
  promote: process.env.ROZE_MODEL_PROMOTE ?? "gpt-5.4-mini",
  tag: process.env.ROZE_MODEL_TAG ?? "gpt-5-nano",
  judge: process.env.ROZE_MODEL_JUDGE ?? "gpt-5.4-mini",
};

/** US dollars per million tokens; a model absent here cannot be budgeted, only spent on. */
export const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-5.5": { input: 5, cached: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cached: 0.02, output: 1.25 },
  "gpt-5.1": { input: 1.25, cached: 0.125, output: 10 },
  "gpt-5": { input: 1.25, cached: 0.125, output: 10 },
  "gpt-5-mini": { input: 0.25, cached: 0.025, output: 2 },
  "gpt-5-nano": { input: 0.05, cached: 0.005, output: 0.4 },
  "gpt-4.1-mini": { input: 0.4, cached: 0.1, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, cached: 0.025, output: 0.4 },
};

/** The 5.4+ families spell "no reasoning" as "none"; older ones only accept "minimal". */
export function chooseReasoningEffort(model: string, level: "minimal" | "low" | "medium" | "high"): ReasoningEffort {
  return level === "minimal" && ["gpt-5.4", "gpt-5.5", "gpt-5.6"].some((family) => model.startsWith(family))
    ? "none"
    : level;
}

/** Null when the model has no price entry, which is what makes a stage unbudgetable. */
export function quoteCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICES[model];
  return price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : null;
}

const emptyUsage = (): ModelUsage => ({
  calls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  usd: 0,
});

// One process-wide ledger prices provider calls and enforces the generation budget.
let spent = emptyUsage();
let paidCalls = 0;

export const usageLedger = {
  record(usage: ProviderUsage, model: string): void {
    const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
    const uncached = usage.inputTokens - cached;
    const price = PRICES[model] ?? { input: 0, cached: 0, output: 0 };
    spent.calls += 1;
    spent.inputTokens += uncached;
    spent.cachedInputTokens += cached;
    spent.outputTokens += usage.outputTokens;
    spent.reasoningTokens += usage.reasoningTokens;
    spent.usd += (uncached * price.input + cached * price.cached + usage.outputTokens * price.output) / 1_000_000;
  },
  total: (): ModelUsage => ({ ...spent }),
  reset: (): void => {
    spent = emptyUsage();
  },
  summaryLine(): string {
    const input = spent.inputTokens + spent.cachedInputTokens;
    return (
      `${spent.calls} calls, ${input.toLocaleString("en-US")} in / ` +
      `${spent.outputTokens.toLocaleString("en-US")} out tokens ` +
      `(${spent.reasoningTokens.toLocaleString("en-US")} reasoning), ≈ $${spent.usd.toFixed(3)}`
    );
  },
  stopIfOverBudget(budget?: number): void {
    if (budget !== undefined && spent.usd > budget + Number.EPSILON)
      throw new Error(
        `Actual model spend $${spent.usd.toFixed(3)} crossed --budget $${budget.toFixed(2)}; ` +
          "cached responses were kept and the previous brain was not changed.",
      );
  },
};

interface CostEstimate {
  calls: number;
  items: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  model: string;
}

export function checkBudgetBeforeStage(
  stage: string,
  estimate: CostEstimate,
  budget: number | undefined,
  context: { log(stage: string): void },
): void {
  const cost = estimate.usd === null ? "unavailable" : `$${estimate.usd.toFixed(3)}`;
  context.log(
    `  ${stage}: ${estimate.calls} calls / ${estimate.items} items, ` +
      `~${estimate.inputTokens.toLocaleString("en-US")} in / ` +
      `${estimate.outputTokens.toLocaleString("en-US")} out on ${estimate.model}; expected ≈ ${cost}`,
  );
  if (budget === undefined || estimate.calls === 0) return;
  if (estimate.usd === null) throw new Error(`Cannot enforce --budget for the configured unpriced ${stage} model.`);
  const remaining = budget - usageLedger.total().usd;
  if (estimate.usd > remaining + Number.EPSILON)
    throw new Error(
      `${stage} expected cost $${estimate.usd.toFixed(2)} exceeds the remaining --budget ` +
        `$${Math.max(0, remaining).toFixed(2)}.`,
    );
}

/** Bumping this invalidates every cached response; the hash below is the cache key. */
const CACHE_VERSION = "model-call-v1\0";
const MAX_PAID_CALLS = 5_000;
const DEFAULT_STAGE = { tokens: 8_000, promptKey: "roze" };
const STAGE_SETTINGS: Record<string, { tokens: number; promptKey: string }> = {
  promotion: { tokens: 8_000, promptKey: "roze-promote" },
  extraction: { tokens: 4_000, promptKey: "roze-extract" },
  topics: { tokens: 4_000, promptKey: "roze-concepts-topics" },
  judge: { tokens: 8_000, promptKey: "roze-concepts-judge" },
  // The review returns every concept with a narrative in one answer, and reasoning shares this cap.
  review: { tokens: 32_000, promptKey: "roze-concepts-review" },
};

export interface CachedModelRequest<Output> {
  kind: string;
  system: string;
  user: string;
  schema: z.ZodType<Output>;
  model: string;
  effort: "minimal" | "low" | "medium" | "high";
  cacheDir: string;
  budget?: number;
}

export type CallModel = <Output>(request: CachedModelRequest<Output>) => Promise<Output>;

export function resetModelState(): void {
  paidCalls = 0;
  usageLedger.reset();
}

/** The schema and the kind are deliberately outside the hash: only what the model saw decides the key. */
export function resolveModelCacheFile(request: CachedModelRequest<unknown>): string {
  const key = hashText(CACHE_VERSION + request.model + request.system + request.user);
  return join(request.cacheDir, `${request.kind}.${key}.json`);
}

export function readCachedModelCall<Output>(request: CachedModelRequest<Output>): Output | undefined {
  const parsed = request.schema.safeParse(readJson(resolveModelCacheFile(request)));
  return parsed.success ? parsed.data : undefined;
}

export async function readCacheOrCall<Output>(
  request: CachedModelRequest<Output>,
  callModel: CallModel,
): Promise<Output> {
  return readCachedModelCall(request) ?? (await callModel(request));
}

/** Kept beside the cache, owner-only, so a validation failure stays inspectable. */
function quarantine(cacheFile: string, response: unknown, error: unknown): void {
  const directory = join(dirname(cacheFile), ".rejected");
  try {
    ensureDirectory(directory);
    chmodSync(directory, 0o700);
    const path = join(directory, basename(cacheFile));
    writeDataAtomically(path, { error: error instanceof Error ? error.message : String(error), response });
    chmodSync(path, 0o600);
  } catch {
    /* Diagnostics must not hide the validation failure. */
  }
}

function readValidCachedResponse<Output>(request: CachedModelRequest<Output>, cacheFile: string): Output | undefined {
  const cached = readJson(cacheFile);
  if (cached === undefined) return undefined;
  const result = request.schema.safeParse(cached);
  if (result.success) return result.data;
  quarantine(cacheFile, cached, result.error);
  return undefined;
}

export async function cachedModelCall<Output>(request: CachedModelRequest<Output>): Promise<Output> {
  const cacheFile = resolveModelCacheFile(request);
  const reused = readValidCachedResponse(request, cacheFile);
  if (reused !== undefined) return reused;
  // Siblings may finish after one crosses budget; queued work must not start another paid call.
  usageLedger.stopIfOverBudget(request.budget);
  if (paidCalls >= MAX_PAID_CALLS) throw new Error(`Model calls exceeded the shared ${MAX_PAID_CALLS}-call ceiling`);
  const stage = STAGE_SETTINGS[request.kind] ?? DEFAULT_STAGE;
  const call = async (effort: CachedModelRequest<Output>["effort"]) => {
    paidCalls += 1;
    const result = await callProvider({
      model: request.model,
      instructions: request.system,
      input: request.user,
      effort: chooseReasoningEffort(request.model, effort),
      schema: z.toJSONSchema(request.schema, { target: "draft-07", io: "input" }),
      maxOutputTokens: stage.tokens,
      promptCacheKey: stage.promptKey,
    });
    usageLedger.record(result.usage, request.model);
    return result;
  };
  let response = await call(request.effort);
  // A reasoning loop can spend the whole cap and answer nothing; one retry at low effort always has.
  if (
    !response.outputText &&
    response.incompleteReason === "max_output_tokens" &&
    !["minimal", "low"].includes(request.effort)
  )
    response = await call("low");
  let value: unknown;
  try {
    if (!response.outputText)
      throw new Error(
        "Provider returned an empty or refused structured response (status " +
          `${response.status || "unknown"}${response.incompleteReason ? `, ${response.incompleteReason}` : ""}; ` +
          `${response.usage.outputTokens} output tokens, ${response.usage.reasoningTokens} of them reasoning, ` +
          `cap ${stage.tokens})`,
      );
    value = JSON.parse(response.outputText);
    const parsed = request.schema.parse(value);
    ensureDirectory(request.cacheDir);
    writeDataAtomically(cacheFile, parsed);
    value = parsed;
  } catch (error) {
    quarantine(cacheFile, value ?? response.outputText, error);
    throw error;
  }
  // Checked after the write: a paid answer is kept even when it is the call that crosses the budget.
  usageLedger.stopIfOverBudget(request.budget);
  return value as Output;
}
