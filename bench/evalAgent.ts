// Runs a question set through the answer agent and records what it did: tools called, threads opened,
// grounding problems in the draft, what survived, cost. Deterministic checks per item plus an optional
// blind judge against a reference answer. Paid, and never part of offline validation.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { z } from "zod";

import { resolveBrainPaths } from "../src/brain/storage.js";
import { cachedModelCall, MODELS, usageLedger } from "../src/llm/models.js";
import { answerOneQuestion, type AnswerResult } from "../src/query/answerAgent.js";
import { runAsScript, writeOut } from "./script.js";

const expectSchema = z
  .object({
    /** At least one of these thread ids must be cited. */
    cite_any_of: z.array(z.string().min(8)).optional(),
    /** The agent must have opened raw messages for every cited thread. */
    read_email: z.boolean().optional(),
    must_match: z.string().optional(),
    must_not_match: z.string().optional(),
    /** The correct answer is a bounded negative. */
    no_evidence: z.boolean().optional(),
    /** Decoy threads: citing one means retrieval picked the look-alike. */
    must_not_cite: z.array(z.string().min(8)).optional(),
  })
  .strict();
const itemSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    category: z.string().default("uncategorized"),
    reference: z.string().optional(),
    expect: expectSchema.default({}),
  })
  .strict();
type Item = z.output<typeof itemSchema>;
const goldenSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string(),
          question: z.string(),
          answer: z.string(),
          category: z.string().optional(),
          evidence: z.array(z.object({ thread_id: z.string() }).loose()).default([]),
          decoys: z.array(z.object({ thread_id: z.string().optional() }).loose()).default([]),
          expected_negative: z
            .object({ boundary_evidence_thread_ids: z.array(z.string()).default([]) })
            .loose()
            .nullable()
            .optional(),
        })
        .loose(),
    ),
  })
  .loose();
const verdictSchema = z.object({ verdict: z.enum(["correct", "partial", "wrong"]), reason: z.string() }).strict();
const JUDGE = `You grade one personal-assistant answer against a known-correct reference.
correct = same requested facts without contradiction; partial = right gist with a material omission;
wrong = contradiction, invention, false absence, another question, or incoherence. Judge substance,
not prose or citation style. You do not know which system produced the answer.`;

function loadItems(file: string): Item[] {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (Array.isArray(raw)) return z.array(itemSchema).parse(raw);
  return goldenSchema.parse(raw).items.map((item) => {
    const evidenceIds = [
      ...new Set([
        ...item.evidence.map((row) => row.thread_id),
        ...(item.expected_negative?.boundary_evidence_thread_ids ?? []),
      ]),
    ];
    const decoyIds = item.decoys
      .flatMap((row) => (row.thread_id ? [row.thread_id] : []))
      .filter((id) => !evidenceIds.includes(id));
    return itemSchema.parse({
      id: item.id,
      question: item.question,
      category: item.category ?? "uncategorized",
      reference: item.answer,
      expect: {
        ...(evidenceIds.length ? { cite_any_of: evidenceIds } : {}),
        ...(decoyIds.length ? { must_not_cite: decoyIds } : {}),
        ...(item.expected_negative ? { no_evidence: true } : {}),
      },
    });
  });
}
interface Check {
  name: string;
  pass: boolean;
  detail: string;
}
interface ItemResult {
  id: string;
  category: string;
  question: string;
  answer: string;
  checks: Check[];
  pass: boolean;
  verdict?: string;
  verdictReason?: string;
  tools: string[];
  toolCalls: number;
  readEmailCalls: number;
  evidenceReads: number;
  readThreads: string[];
  cited: string[];
  draftGroundingProblems: string[];
  verificationRound: boolean;
  headerRound: boolean;
  unverified: string[];
  usd: number;
  seconds: number;
}

function evaluate(item: Item, result: AnswerResult): Check[] {
  const checks: Check[] = [];
  const expect = item.expect,
    cited = new Set(result.cited);
  checks.push({
    name: "grounded",
    pass: result.unverified.length === 0,
    detail: result.unverified.join(", ") || "every citation was read and dated",
  });
  if (expect.cite_any_of)
    checks.push({
      name: "cites_expected_thread",
      pass: expect.cite_any_of.some((id) => cited.has(id)),
      detail: `cited ${result.cited.join(", ") || "nothing"}`,
    });
  if (expect.read_email)
    checks.push({
      name: "used_read_email",
      pass: result.toolCalls.some((call) => call.tool === "read_email"),
      detail: result.toolCalls.map((call) => call.command).join("; "),
    });
  if (expect.must_match)
    checks.push({
      name: "must_match",
      pass: new RegExp(expect.must_match, "iu").test(result.answer),
      detail: expect.must_match,
    });
  if (expect.must_not_match)
    checks.push({
      name: "must_not_match",
      pass: !new RegExp(expect.must_not_match, "iu").test(result.answer),
      detail: expect.must_not_match,
    });
  if (expect.no_evidence)
    checks.push({
      name: "bounded_negative",
      pass: /\bno\b|nothing in your email|not in your email|never|did not|didn.t|does not|doesn.t|I don.t see/iu.test(
        result.answer,
      ),
      detail: "answer should state the absence",
    });
  if (expect.must_not_cite)
    checks.push({
      name: "no_decoy_cited",
      pass: !expect.must_not_cite.some((id) => cited.has(id)),
      detail: `decoys ${expect.must_not_cite.join(", ")}`,
    });
  return checks;
}

type Verdict = z.output<typeof verdictSchema>;

/** Blind: it sees the question, the reference, and the candidate, but not the system. */
async function judgeAnswer(item: Item, answer: string, model: string, cacheDir: string): Promise<Verdict> {
  return cachedModelCall({
    kind: "eval-judge",
    system: JUDGE,
    user: `Question:\n${item.question}\n\nReference:\n${item.reference ?? ""}\n\nCandidate:\n${answer}`,
    schema: verdictSchema,
    model,
    effort: "minimal",
    cacheDir: join(cacheDir, "eval"),
  });
}

async function runItem(item: Item, brainRoot: string, cacheDir: string, cap: number, model?: string, judge?: string) {
  const started = performance.now();
  const result = await answerOneQuestion(item.question, { root: brainRoot, cap, model });
  const checks = evaluate(item, result);
  let verdict: Verdict | undefined;
  if (judge && item.reference) {
    verdict = await judgeAnswer(item, result.answer, judge, cacheDir);
    checks.push({
      name: "judge_correct",
      pass: verdict.verdict === "correct",
      detail: `${verdict.verdict}: ${verdict.reason}`,
    });
  }
  const row: ItemResult = {
    id: item.id,
    category: item.category,
    question: item.question,
    answer: result.answer,
    checks,
    pass: checks.every((check) => check.pass),
    verdict: verdict?.verdict,
    verdictReason: verdict?.reason,
    tools: result.toolCalls.map((call) => call.command),
    toolCalls: result.toolCalls.length,
    readEmailCalls: result.toolCalls.filter((call) => call.tool === "read_email").length,
    evidenceReads: result.toolCalls.filter(
      (call) => call.tool === "read_memory" && call.command.includes("evidence/threads/"),
    ).length,
    readThreads: result.readThreads,
    cited: result.cited,
    draftGroundingProblems: result.draftAudit,
    verificationRound: result.verificationRound,
    headerRound: result.headerRound,
    unverified: result.unverified,
    usd: Math.round(result.usage.usd * 10_000) / 10_000,
    seconds: Math.round((performance.now() - started) / 100) / 10,
  };
  return row;
}

function selectItems(file: string, only?: string): Item[] {
  const wanted = new Set(
    (only ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return loadItems(file).filter((item) => !wanted.size || wanted.has(item.category) || wanted.has(item.id));
}

function summarizeResults(results: readonly ItemResult[]) {
  const count = (predicate: (row: ItemResult) => boolean) => results.filter(predicate).length;
  const checkRate = (name: string) => ({
    checked: count((row) => row.checks.some((check) => check.name === name)),
    pass: count((row) => row.checks.some((check) => check.name === name && check.pass)),
  });
  const byCategory = Object.fromEntries(
    [...new Set(results.map((row) => row.category))].sort().map((category) => {
      const rows = results.filter((row) => row.category === category);
      return [
        category,
        {
          items: rows.length,
          pass: rows.filter((row) => row.pass).length,
          correct: rows.filter((row) => row.verdict === "correct").length,
          partial: rows.filter((row) => row.verdict === "partial").length,
          wrong: rows.filter((row) => row.verdict === "wrong").length,
        },
      ];
    }),
  );
  return {
    items: results.length,
    pass: count((row) => row.pass),
    grounded: count((row) => !row.unverified.length),
    verdicts: {
      correct: count((row) => row.verdict === "correct"),
      partial: count((row) => row.verdict === "partial"),
      wrong: count((row) => row.verdict === "wrong"),
    },
    citesExpectedThread: checkRate("cites_expected_thread"),
    noDecoyCited: checkRate("no_decoy_cited"),
    boundedNegative: checkRate("bounded_negative"),
    byCategory,
    draftsNeedingVerification: count((row) => row.draftGroundingProblems.length > 0),
    headerRounds: count((row) => row.headerRound),
    usedReadEmail: count((row) => row.readEmailCalls > 0),
    openedRawMailBeforeAnswering: count((row) => row.readThreads.length > 0),
    meanToolCalls: results.length
      ? Math.round((10 * results.reduce((sum, row) => sum + row.toolCalls, 0)) / results.length) / 10
      : 0,
    usd: Math.round(results.reduce((sum, row) => sum + row.usd, 0) * 1_000) / 1_000,
  };
}

async function evaluateAgent(
  file: string,
  root: string | undefined,
  cap: number,
  model?: string,
  judge?: string,
  only?: string,
) {
  const paths = resolveBrainPaths(root);
  const items = selectItems(file, only);
  const results: ItemResult[] = [];
  for (const item of items) results.push(await runItem(item, paths.root, paths.cacheDir, cap, model, judge));
  return {
    file,
    brain: paths.root,
    model: model ?? MODELS.answer,
    judge: judge ?? null,
    cap,
    ranAt: new Date().toISOString(),
    totals: summarizeResults(results),
    results,
  };
}

const TABLE_HEADER = [
  "| id | category | pass | verdict | tools | opened | draft problems | unverified | $ | s | failed checks |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
];

function tableRow(row: ItemResult): string {
  const failedChecks = row.checks
    .filter((check) => !check.pass)
    .map((check) => check.name)
    .join(", ");
  const cells = [
    row.id,
    row.category,
    row.pass ? "yes" : "NO",
    row.verdict ?? "-",
    row.toolCalls,
    row.readThreads.length,
    row.draftGroundingProblems.length,
    row.unverified.length,
    row.usd,
    row.seconds,
    failedChecks,
  ];
  return `| ${cells.join(" | ")} |`;
}

function renderTable(run: Awaited<ReturnType<typeof evaluateAgent>>): string {
  const lines = [...TABLE_HEADER, ...run.results.map(tableRow)];
  return `${lines.join("\n")}\n${JSON.stringify(run.totals)}\n`;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      brain: { type: "string" },
      cap: { type: "string" },
      model: { type: "string" },
      out: { type: "string" },
      judge: { type: "boolean" },
      "judge-model": { type: "string" },
      only: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 1)
    throw new Error(
      "Usage: tsx bench/evalAgent.ts <questions.json|golden.json> [--brain path] [--cap 8] [--model m] [--judge] [--judge-model m] [--only category|id] [--out results.json]",
    );
  const cap = values.cap === undefined ? 8 : Number(values.cap);
  if (!Number.isInteger(cap) || cap < 0) throw new Error("cap must be a non-negative integer");
  usageLedger.reset();
  const run = await evaluateAgent(
    positionals[0]!,
    values.brain,
    cap,
    values.model,
    values.judge ? (values["judge-model"] ?? MODELS.judge) : undefined,
    values.only,
  );
  if (values.out) writeOut(values.out, `${JSON.stringify(run, null, 2)}\n`);
  process.stdout.write(renderTable(run));
  if (values.out) process.stderr.write(`Wrote ${values.out}\n`);
}

runAsScript(import.meta.url, main, "Agent evaluation");
