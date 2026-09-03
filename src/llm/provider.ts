// The only place that speaks HTTP to a model provider: one POST to the Responses API, a bounded retry, and
// a defensive read into a flat ProviderResult. Prices, budgets, and caching are models.ts's job.

import { loadEnvironmentFile } from "../shared/atomicFiles.js";
import { cleanText } from "../shared/text.js";
import type { ModelUsage } from "../types.js";

const API_URL = "https://api.openai.com/v1/responses";
const MAX_ATTEMPTS = 3;

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

export interface FunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: true;
}

export interface ProviderRequest {
  model: string;
  instructions: string;
  input: string | unknown[];
  tools?: FunctionTool[];
  toolChoice?: "auto" | "none";
  effort: ReasoningEffort;
  schema?: Record<string, unknown>;
  maxOutputTokens: number;
  promptCacheKey?: string;
}

export type ProviderUsage = Pick<ModelUsage, "inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningTokens">;

export interface ProviderResult {
  outputText: string;
  /** "completed" normally; "incomplete" with the reason when the output cap or a filter cut it short. */
  status: string;
  incompleteReason: string;
  functionCalls: Array<{ callId: string; name: string; argumentsJson: string }>;
  outputItems: unknown[];
  usage: ProviderUsage;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const asNumber = (value: unknown): number => (typeof value === "number" ? value : 0);

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

function readFunctionCalls(outputItems: unknown[]): ProviderResult["functionCalls"] {
  return outputItems.flatMap((item) => {
    const call = asRecord(item);
    return call?.type === "function_call" &&
      typeof call.call_id === "string" &&
      typeof call.name === "string" &&
      typeof call.arguments === "string"
      ? [{ callId: call.call_id, name: call.name, argumentsJson: call.arguments }]
      : [];
  });
}

function readNestedText(outputItems: unknown[]): string {
  return outputItems
    .flatMap((item) => {
      const content = asRecord(item)?.content;
      return Array.isArray(content)
        ? content.flatMap((part) => {
            const block = asRecord(part);
            return block?.type === "output_text" && typeof block.text === "string" ? [block.text] : [];
          })
        : [];
    })
    .join("");
}

function readUsage(response: Record<string, unknown>): ProviderUsage {
  const usage = asRecord(response.usage);
  const input = asRecord(usage?.input_tokens_details);
  const output = asRecord(usage?.output_tokens_details);
  return {
    inputTokens: asNumber(usage?.input_tokens),
    cachedInputTokens: asNumber(input?.cached_tokens),
    outputTokens: asNumber(usage?.output_tokens),
    reasoningTokens: asNumber(output?.reasoning_tokens),
  };
}

/** Nothing in the answer is trusted to exist or to have the documented type. */
function readProviderResult(value: unknown): ProviderResult {
  const response = asRecord(value);
  if (!response) throw new Error("OpenAI returned a non-object response");
  const outputItems = Array.isArray(response.output) ? response.output : [];
  return {
    outputText: typeof response.output_text === "string" ? response.output_text : readNestedText(outputItems),
    status: typeof response.status === "string" ? response.status : "",
    incompleteReason: String(asRecord(response.incomplete_details)?.reason ?? ""),
    functionCalls: readFunctionCalls(outputItems),
    outputItems,
    usage: readUsage(response),
  };
}

function buildRequestBody(request: ProviderRequest): Record<string, unknown> {
  return {
    model: request.model,
    instructions: request.instructions,
    input: request.input,
    tools: request.tools,
    tool_choice: request.toolChoice,
    reasoning: { effort: request.effort },
    max_output_tokens: request.maxOutputTokens,
    prompt_cache_key: request.promptCacheKey,
    text: request.schema
      ? { format: { type: "json_schema", name: "brain", schema: request.schema, strict: true } }
      : undefined,
  };
}

interface ProviderFailure {
  message: string;
  /** A 4xx other than 429 is the caller's fault and would fail identically on every attempt. */
  permanent: boolean;
  retryDelayMs: number;
}

function describeProviderFailure(response: Response, detail: string, attempt: number): ProviderFailure {
  if (response.status !== 429 && response.status < 500)
    return {
      message: `OpenAI request failed (${response.status} ${response.statusText}): ${detail}`,
      permanent: true,
      retryDelayMs: 0,
    };
  const header = response.headers.get("retry-after");
  const retryAfter = header === null ? Number.NaN : Number(header);
  return {
    message: `OpenAI request failed (${response.status}): ${detail}`,
    permanent: false,
    retryDelayMs: Number.isFinite(retryAfter) ? retryAfter * 1_000 : attempt * 1_000,
  };
}

export async function callProvider(request: ProviderRequest): Promise<ProviderResult> {
  // Re-read each call: a key added to .env after startup must work without restarting the CLI.
  loadEnvironmentFile();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY. Add it to .env.");
  const body = buildRequestBody(request);
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let failure: ProviderFailure;
    try {
      const response = await globalThis.fetch(API_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.ok) return readProviderResult(await response.json());
      failure = describeProviderFailure(response, cleanText(await response.text(), 800), attempt);
    } catch (error) {
      // A transport failure, or an answer that would not read: both are worth one more attempt.
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await wait(attempt * 1_000);
      }
      continue;
    }
    if (failure.permanent) throw new Error(failure.message);
    lastError = new Error(failure.message);
    if (attempt < MAX_ATTEMPTS) {
      await wait(failure.retryDelayMs);
    }
  }
  throw new Error(
    `OpenAI request failed after ${MAX_ATTEMPTS} attempts: ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
