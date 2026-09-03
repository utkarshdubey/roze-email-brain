// The bounded agent loop behind `roze prompt`: one question in, one cited answer out.
//
//   question → search_memory | read_memory | read_email → draft → citation audit → answer
//
// Three things make it terminate with something trustworthy: a tool budget that extends only while the
// last window kept opening new material, so "list everything" continues and a repeating loop stops; a
// grounding audit that buys at most one repair round in which the agent must read what it cited; and one
// header round, because an absence claim is not an answer while surfaced header-only rows stay unread.
import { chooseReasoningEffort, MODELS, usageLedger } from "../llm/models.js";
import { callProvider, type ProviderRequest, type ProviderResult } from "../llm/provider.js";
import { resolveBrainPaths } from "../brain/storage.js";
import { readCurrentCalendarDay } from "../shared/dates.js";
import type { ModelUsage } from "../types.js";
import { buildAnswerInstructions } from "./answerPrompt.js";
import {
  ABSENCE,
  auditCitations,
  auditKeys,
  CITATION,
  citationKeysIn,
  describeAudit,
  type CitationAudit,
} from "./citations.js";
import { executeTool, type FetchThread } from "./memoryTools.js";
import { TOOL_DEFINITIONS } from "./toolContracts.js";

/** Added per extension, while the previous window kept opening new threads or views. */
const EXTENSION = 8;
const DEFAULT_MAX_CALLS = 48;
const MAX_USD = 1;
const MAX_VERIFICATION_READS = 4;

/** A read_memory path that opens one thread's raw messages, as opposed to a derived view. */
const EVIDENCE_PATH = /^evidence\/threads\/([0-9a-f]{8,})\.md$/u;
/** Header-only rows in a search result: candidates for the header round behind an absence claim. */
const HEADER_ROW = /^evidence\/inbox-\d{4}\.md:\d+: ([0-9a-f]{8,}) \|/gmu;

export interface AnswerOptions {
  maxCalls?: number;
  cap?: number;
  model?: string;
  verbose?: boolean;
  trace?: (line: string) => void;
  root?: string;
  today?: string;
  fetchThread?: FetchThread;
}

interface ToolTrace {
  tool: string;
  command: string;
}

export interface AnswerResult {
  answer: string;
  cited: string[];
  toolCalls: ToolTrace[];
  usage: ModelUsage;
  /** Exposed for deterministic evaluation of retrieval and grounding. */
  readThreads: string[];
  draftAudit: string[];
  verificationRound: boolean;
  headerRound: boolean;
  unverified: string[];
  extensions: number;
}

export type CreateResponse = (request: ProviderRequest) => Promise<ProviderResult>;
type Trace = (line: string) => void;

interface RetrievalLog {
  toolCalls: ToolTrace[];
  readThreads: Set<string>;
  /** Derived views read; their citations are grounded without opening the raw thread. */
  openedViews: Set<string>;
  readCitations: Set<string>;
  /** Surfaced by the agent's own searches, but not necessarily read. */
  headerCandidates: Set<string>;
}

interface AgentState {
  input: unknown[];
  log: RetrievalLog;
  answer: string;
  allowance: number;
  extensions: number;
  openedAtLastCheck: number;
  verified: boolean;
  headerRound: boolean;
  draftAudit: string[];
  unverified?: CitationAudit;
}

function newState(query: string, cap: number): AgentState {
  return {
    input: [{ role: "user", content: query }],
    log: {
      toolCalls: [],
      readThreads: new Set(),
      openedViews: new Set(),
      readCitations: new Set(),
      headerCandidates: new Set(),
    },
    answer: "",
    allowance: cap,
    extensions: 0,
    openedAtLastCheck: 0,
    verified: false,
    headerRound: false,
    draftAudit: [],
  };
}

function parseArguments(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function formatTraceLabel(name: string, args: Record<string, unknown>): string {
  if (name === "read_memory") return `read ${String(args.path ?? "")}`;
  if (name === "read_email") return `gmail ${String(args.thread_id ?? "")}`;
  if (name !== "search_memory") return name;
  const grouped = args.group_by && args.group_by !== "none";
  const summed = args.amounts === "sum" ? ", sum amounts" : "";
  const period = args.from || args.to ? `, ${String(args.from ?? "") || "…"}..${String(args.to ?? "") || "…"}` : "";
  const tally = grouped ? ` (tally by ${String(args.group_by)}${summed}${period})` : "";
  return `search ${String(args.scope ?? "")} ${String(args.query ?? "")}${tally}`;
}

/** Files a tool result under everything the grounding audit and header round depend on. */
function noteToolOutput(log: RetrievalLog, name: string, args: Record<string, unknown>, output: string): void {
  const failed = output.startsWith("error:");
  const openedThread =
    name === "read_email" ? String(args.thread_id ?? "") : (EVIDENCE_PATH.exec(String(args.path ?? ""))?.[1] ?? "");
  if (openedThread && !failed) {
    log.readThreads.add(openedThread);
  }
  if (name === "read_memory" && !openedThread && !failed) {
    log.openedViews.add(String(args.path ?? ""));
    for (const key of citationKeysIn(output)) {
      log.readCitations.add(key);
    }
  }
  if (name === "search_memory") {
    for (const match of output.matchAll(HEADER_ROW)) {
      log.headerCandidates.add(match[1]!);
    }
    // A tally row is generated from the thread and day it cites, so its example citation is grounded.
    if (args.group_by && args.group_by !== "none") {
      for (const key of citationKeysIn(output)) {
        log.readCitations.add(key);
      }
    }
  }
}

/**
 * The budget follows progress: while the last window kept opening new material and the hard ceilings
 * allow it, the agent may continue; a window that only repeated itself ends the search.
 */
function extendBudgetIfProgressing(state: AgentState, maxCalls: number, trace: Trace): boolean {
  const opened = state.log.readThreads.size + state.log.openedViews.size;
  const progressing = opened > state.openedAtLastCheck;
  const withinCeilings = state.log.toolCalls.length + EXTENSION <= maxCalls && usageLedger.total().usd < MAX_USD;
  state.openedAtLastCheck = opened;
  if (!progressing || !withinCeilings) return false;
  state.extensions += 1;
  state.allowance += EXTENSION;
  state.input.push({
    role: "user",
    content:
      `Budget extended: you have ${state.allowance - state.log.toolCalls.length} more tool calls because your last ` +
      "calls kept opening new material. Continue until the question is fully answered or the sources " +
      "are exhausted; do not stop early.",
  });
  trace(`budget extended to ${state.allowance} calls (still opening new material)`);
  return true;
}

function budgetExhausted(state: AgentState, maxCalls: number, trace: Trace): boolean {
  if (state.log.toolCalls.length < state.allowance) return false;
  const canExtend = !state.verified && !state.headerRound;
  if (canExtend && extendBudgetIfProgressing(state, maxCalls, trace)) return false;
  state.input.push({
    role: "user",
    content:
      `You have used all ${state.allowance} tool calls. Answer now in prose with citations using only ` +
      "outputs already read.",
  });
  return true;
}

/** Runs what the allowance covers and refuses the rest as tool output, never as an error. */
async function runRequestedCalls(
  state: AgentState,
  response: ProviderResult,
  root: string,
  live: FetchThread | undefined,
  trace: Trace,
): Promise<void> {
  state.input.push(...response.outputItems);
  const allowed = response.functionCalls.slice(0, Math.max(0, state.allowance - state.log.toolCalls.length));
  for (const call of allowed) {
    const args = parseArguments(call.argumentsJson);
    const output = await executeTool(call.name, args, root, live);
    noteToolOutput(state.log, call.name, args, output);
    const label = formatTraceLabel(call.name, args);
    state.log.toolCalls.push({ tool: call.name, command: label });
    trace(`${call.name}: ${label}`);
    state.input.push({ type: "function_call_output", call_id: call.callId, output });
  }
  for (const call of response.functionCalls.slice(allowed.length))
    state.input.push({ type: "function_call_output", call_id: call.callId, output: "error: tool-call cap reached" });
}

/** An absence claim while unread header-only candidates exist is not yet an answer; false accepts it. */
function startHeaderRound(state: AgentState, response: ProviderResult, trace: Trace): boolean {
  const candidates = [...state.log.headerCandidates]
    .filter((id) => !state.log.readThreads.has(id))
    .slice(0, MAX_VERIFICATION_READS);
  if (!candidates.length) return false;
  state.headerRound = true;
  state.allowance = state.log.toolCalls.length + candidates.length;
  state.input.push(...response.outputItems, {
    role: "user",
    content:
      "Before saying something is not in the email: your searches surfaced header-only inbox rows " +
      `you have not read (${candidates.join(", ")}). You have ${candidates.length} more tool calls. ` +
      "Call read_email on the most relevant of them, then answer again from what the messages " +
      "actually say, citing them; keep the absence claim only if they do not contain it.",
  });
  trace(`header check: reading ${candidates.length} unread header row(s) before accepting an absence claim`);
  return true;
}

/** One verification round: the draft stays in context and the agent must read what it cited. */
function startVerificationRound(
  state: AgentState,
  response: ProviderResult,
  audit: CitationAudit,
  problems: string[],
  trace: Trace,
): void {
  state.draftAudit = problems;
  state.verified = true;
  state.allowance = state.log.toolCalls.length + Math.min(MAX_VERIFICATION_READS, problems.length);
  state.input.push(...response.outputItems, {
    role: "user",
    content:
      `Grounding check failed (${describeAudit(audit)}). Derived views are leads, not evidence. You have ` +
      `${state.allowance - state.log.toolCalls.length} more tool calls: read each cited thread's raw messages ` +
      "(read_memory on evidence/threads/<id>.md, or read_email for a skim-tier thread), then answer again " +
      "keeping only claims those messages support, citing only threads you have read with a day that " +
      "heads one of their messages. Drop any claim you cannot verify and say so.",
  });
  trace(`grounding: ${describeAudit(audit)}`);
}

function reviewDraft(state: AgentState, response: ProviderResult, root: string, trace: Trace): boolean {
  state.answer = response.outputText;
  const audit = auditCitations(state.answer, root, state.log.readThreads, state.log.readCitations);
  const problems = auditKeys(audit);
  if (!problems.length) {
    if (!state.headerRound && ABSENCE.test(state.answer) && startHeaderRound(state, response, trace)) return false;
    return true;
  }
  if (state.verified) {
    state.unverified = audit;
    return true;
  }
  startVerificationRound(state, response, audit, problems, trace);
  return false;
}

function toAnswerResult(state: AgentState): AnswerResult {
  const answer = state.unverified
    ? `${state.answer}\n\n[Grounding warning — ${describeAudit(state.unverified)}. Treat those claims as unverified.]`
    : state.answer;
  return {
    answer,
    cited: [...new Set([...answer.matchAll(CITATION)].map((match) => match[1]!))].sort(),
    toolCalls: state.log.toolCalls,
    usage: usageLedger.total(),
    readThreads: [...state.log.readThreads].sort(),
    draftAudit: state.draftAudit,
    verificationRound: state.verified,
    headerRound: state.headerRound,
    extensions: state.extensions,
    unverified: state.unverified ? auditKeys(state.unverified) : [],
  };
}

function createTrace(options: AnswerOptions): Trace {
  return (line) => {
    if (!options.verbose) return;
    const text = line.length > 110 ? `${line.slice(0, 107)}…` : line;
    if (options.trace) options.trace(text);
    else process.stderr.write(`  ${text}\n`);
  };
}

/** Tools stay declared at the cap so the final request keeps the same cached prompt prefix. */
export async function answerOneQuestion(
  query: string,
  options: AnswerOptions = {},
  create: CreateResponse = callProvider,
): Promise<AnswerResult> {
  const cap = options.cap ?? 12;
  if (!Number.isInteger(cap) || cap < 0) throw new Error("tool-call cap must be a non-negative integer");
  const root = resolveBrainPaths(options.root).root;
  const instructions = buildAnswerInstructions(root, options.today ?? readCurrentCalendarDay(), cap);
  const maxCalls = Math.max(cap, options.maxCalls ?? DEFAULT_MAX_CALLS);
  const model = options.model ?? MODELS.answer;
  const live = options.fetchThread;
  const trace = createTrace(options);
  const state = newState(query, cap);

  usageLedger.reset();
  // Each round can add a repair or header read on top of the calls; the slack ends runaway loops.
  const turnLimit = maxCalls + 2 * MAX_VERIFICATION_READS + 5;
  for (let turn = 0; turn < turnLimit; turn += 1) {
    const exhausted = budgetExhausted(state, maxCalls, trace);
    const response = await create({
      model,
      instructions,
      input: [...state.input],
      tools: TOOL_DEFINITIONS,
      toolChoice: exhausted ? "none" : "auto",
      effort: chooseReasoningEffort(model, "low"),
      maxOutputTokens: 4_000,
      promptCacheKey: "roze-brain-typed-retrieval",
    });
    usageLedger.record(response.usage, model);
    if (!response.functionCalls.length || exhausted) {
      if (reviewDraft(state, response, root, trace)) break;
      continue;
    }
    await runRequestedCalls(state, response, root, live, trace);
  }
  return toAnswerResult(state);
}
