// Runs the same bounded search_memory calls against a cited golden set and measures whether expected
// threads surface, without calling a model or the network. Literal and FTS runs are explicit so an FTS
// failure cannot be reported as an indexed result after silently falling back to the scanner.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { z } from "zod";

import { resolveBrainPaths, type SearchScope } from "../src/brain/storage.js";
import { searchMemory } from "../src/query/memorySearch.js";
import type { Match } from "../src/query/toolContracts.js";
import { runAsScript, writeOut } from "./script.js";

const ENGINES = ["literal", "fts"] as const;
type Engine = (typeof ENGINES)[number];

const BENCH_SCOPES = ["all", "thread_summaries"] as const satisfies readonly SearchScope[];
type BenchScope = (typeof BENCH_SCOPES)[number];
const BENCH_MATCHES = ["all_terms", "any_term"] as const satisfies readonly Match[];
type BenchMatch = (typeof BENCH_MATCHES)[number];

const expectedCitationsSchema = z
  .object({
    cite_any_of: z.array(z.string().min(1)).optional(),
  })
  .loose()
  .default({});

const exampleItemSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    expect: expectedCitationsSchema,
  })
  .loose();

const goldenSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string().min(1),
          question: z.string().min(1),
          expect: expectedCitationsSchema,
          evidence: z.array(z.object({ thread_id: z.string().min(1) }).loose()).default([]),
          expected_negative: z
            .object({
              boundary_evidence_thread_ids: z.array(z.string().min(1)).default([]),
            })
            .loose()
            .nullable()
            .optional(),
        })
        .loose(),
    ),
  })
  .loose();

interface RetrievalItem {
  id: string;
  question: string;
  expectedThreadIds: string[];
}

interface ParsedRank {
  rank: number | null;
  threadId: string | null;
  totalMatches: number;
}

interface SearchResult extends ParsedRank {
  id: string;
  scope: BenchScope;
  match: BenchMatch;
  milliseconds: number;
}

interface Rate {
  hits: number;
  rate: number;
}

interface Metrics {
  scope: BenchScope;
  match: BenchMatch;
  searches: number;
  hitAt5: Rate;
  hitAt10: Rate;
  hitAt20: Rate;
  mrr: number;
  meanMilliseconds: number;
}

const RESULT_LINE = /^([^:]+):(\d+): (.*)$/u;
const RAW_THREAD_PATH = /^evidence\/threads\/([0-9a-f]{8,})\.md$/iu;
const YEAR_ROW = /^([0-9a-f]{8,}) \|/iu;
const CITATION = /\[t:([0-9a-f]{8,})(?=\s|\])/giu;
const OMITTED_MIDDLE = /^…\[middle omitted; \d+ chars total\]…$/u;

function uniqueThreadIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function loadItems(file: string): RetrievalItem[] {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (Array.isArray(raw)) {
    return z
      .array(exampleItemSchema)
      .parse(raw)
      .flatMap((item) => {
        const expectedThreadIds = uniqueThreadIds(item.expect.cite_any_of ?? []);
        return expectedThreadIds.length ? [{ id: item.id, question: item.question, expectedThreadIds }] : [];
      });
  }

  return goldenSchema.parse(raw).items.flatMap((item) => {
    const expectedThreadIds = uniqueThreadIds([
      ...(item.expect.cite_any_of ?? []),
      ...item.evidence.map((row) => row.thread_id),
      ...(item.expected_negative?.boundary_evidence_thread_ids ?? []),
    ]);
    return expectedThreadIds.length ? [{ id: item.id, question: item.question, expectedThreadIds }] : [];
  });
}

function idsInResultLine(line: string): string[] {
  const result = RESULT_LINE.exec(line);
  if (!result) return [];
  const ids: string[] = [];
  const pathId = RAW_THREAD_PATH.exec(result[1]!)?.[1];
  const rowId = YEAR_ROW.exec(result[3]!)?.[1];
  if (pathId) ids.push(pathId);
  if (rowId) ids.push(rowId);
  for (const match of result[3]!.matchAll(CITATION)) ids.push(match[1]!);
  return uniqueThreadIds(ids);
}

/** A capped result can retain the suffix of one row without its path prefix. */
function idsInTrailingFragment(line: string): string[] {
  const ids: string[] = [];
  const rowId = YEAR_ROW.exec(line)?.[1];
  if (rowId) ids.push(rowId);
  for (const match of line.matchAll(CITATION)) ids.push(match[1]!);
  return uniqueThreadIds(ids);
}

function matchingExpectedId(line: string, expected: ReadonlySet<string>, fragment = false): string | undefined {
  const ids = fragment ? idsInTrailingFragment(line) : idsInResultLine(line);
  return ids.find((id) => expected.has(id.toLowerCase()));
}

function parseRank(output: string, expectedThreadIds: readonly string[]): ParsedRank {
  const lines = output.split("\n");
  const header = /^(\d+) of (\d+) matches\b/u.exec(lines[0] ?? "");
  if (!header) return { rank: null, threadId: null, totalMatches: 0 };

  const selectedCount = Number(header[1]);
  const totalMatches = Number(header[2]);
  const expected = new Set(expectedThreadIds.map((id) => id.toLowerCase()));
  const body = lines.slice(1);
  const markerIndex = body.findIndex((line) => OMITTED_MIDDLE.test(line));
  if (markerIndex === -1) {
    let rank = 0;
    for (const line of body) {
      if (!RESULT_LINE.test(line)) continue;
      rank += 1;
      const threadId = matchingExpectedId(line, expected);
      if (threadId) return { rank, threadId, totalMatches };
    }
    return { rank: null, threadId: null, totalMatches };
  }

  let rank = 0;
  for (const line of body.slice(0, markerIndex)) {
    if (!RESULT_LINE.test(line)) continue;
    rank += 1;
    const threadId = matchingExpectedId(line, expected);
    if (threadId) return { rank, threadId, totalMatches };
  }

  const tail = body.slice(markerIndex + 1);
  const completeTail = tail.filter((line) => RESULT_LINE.test(line));
  const firstTailLine = tail[0];
  if (firstTailLine && !RESULT_LINE.test(firstTailLine)) {
    const threadId = matchingExpectedId(firstTailLine, expected, true);
    if (threadId) return { rank: selectedCount - completeTail.length, threadId, totalMatches };
  }
  const firstTailRank = selectedCount - completeTail.length + 1;
  for (const [index, line] of completeTail.entries()) {
    const threadId = matchingExpectedId(line, expected);
    if (threadId) return { rank: firstTailRank + index, threadId, totalMatches };
  }
  return { rank: null, threadId: null, totalMatches };
}

/** Keeps the evolving searchMemory override at one bench-only seam. */
function runSearch(brain: string, item: RetrievalItem, scope: BenchScope, match: BenchMatch, engine: Engine): string {
  const options =
    engine === "fts"
      ? {
          engine,
          onIndexFallback: (message: string): never => {
            throw new Error(`FTS search fell back to the literal scanner: ${message}`);
          },
        }
      : { engine };
  // The tool contract caps a query at 200 characters, so a long question is cut at the last word inside it.
  const query = item.question.length <= 200 ? item.question : item.question.slice(0, 200).replace(/\s+\S*$/u, "");
  return searchMemory(brain, query, scope, match, 20, "none", "ignore", "", "", options);
}

function runBench(items: readonly RetrievalItem[], brain: string, engine: Engine): SearchResult[] {
  const results: SearchResult[] = [];
  for (const item of items) {
    for (const scope of BENCH_SCOPES) {
      for (const match of BENCH_MATCHES) {
        const started = performance.now();
        const output = runSearch(brain, item, scope, match, engine);
        const milliseconds = performance.now() - started;
        results.push({ id: item.id, scope, match, milliseconds, ...parseRank(output, item.expectedThreadIds) });
      }
    }
  }
  return results;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function hitRate(rows: readonly SearchResult[], limit: number): Rate {
  const hits = rows.filter((row) => row.rank !== null && row.rank <= limit).length;
  return { hits, rate: rows.length ? round(hits / rows.length) : 0 };
}

function summarize(results: readonly SearchResult[]): Metrics[] {
  return BENCH_SCOPES.flatMap((scope) =>
    BENCH_MATCHES.map((match) => {
      const rows = results.filter((row) => row.scope === scope && row.match === match);
      return {
        scope,
        match,
        searches: rows.length,
        hitAt5: hitRate(rows, 5),
        hitAt10: hitRate(rows, 10),
        hitAt20: hitRate(rows, 20),
        mrr: rows.length ? round(rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / rows.length) : 0,
        meanMilliseconds: rows.length
          ? round(rows.reduce((sum, row) => sum + row.milliseconds, 0) / rows.length)
          : 0,
      };
    }),
  );
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function renderTable(
  engine: Engine,
  metrics: readonly Metrics[],
  preparationMilliseconds: number,
  overallMeanMilliseconds: number,
): string {
  const lines = [
    "| engine | scope | match | n | hit@5 | hit@10 | hit@20 | MRR | ms/search |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|",
    ...metrics.map(
      (row) =>
        `| ${engine} | ${row.scope} | ${row.match} | ${row.searches} | ${percent(row.hitAt5.rate)} | ` +
        `${percent(row.hitAt10.rate)} | ${percent(row.hitAt20.rate)} | ${row.mrr.toFixed(4)} | ` +
        `${row.meanMilliseconds.toFixed(2)} |`,
    ),
  ];
  return (
    `${lines.join("\n")}\n` +
    `Preparation: ${preparationMilliseconds.toFixed(2)} ms; ` +
    `overall mean: ${overallMeanMilliseconds.toFixed(2)} ms/search\n`
  );
}

function parseEngine(value: string | undefined): Engine {
  if (value === "literal" || value === "fts") return value;
  throw new Error("--engine must be literal or fts");
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      brain: { type: "string" },
      engine: { type: "string" },
      out: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 1) {
    throw new Error(
      "Usage: tsx bench/retrievalRecall.ts <questions.json|golden.json> " +
        "--engine literal|fts [--brain path] [--out results.json]",
    );
  }

  const engine = parseEngine(values.engine);
  const source = resolve(positionals[0]!);
  const brain = resolveBrainPaths(values.brain).root;
  const items = loadItems(source);
  if (!items.length) throw new Error("question set has no items with expected citation thread ids");

  let preparationMilliseconds = 0;
  if (engine === "fts") {
    const started = performance.now();
    runSearch(brain, items[0]!, BENCH_SCOPES[0], BENCH_MATCHES[0], engine);
    preparationMilliseconds = round(performance.now() - started);
  }
  const results = runBench(items, brain, engine);
  const metrics = summarize(results);
  const overallMeanMilliseconds = round(
    results.reduce((sum, row) => sum + row.milliseconds, 0) / results.length,
  );
  const run = {
    source,
    brain,
    engine,
    ranAt: new Date().toISOString(),
    items: items.length,
    searches: results.length,
    preparationMilliseconds,
    overallMeanMilliseconds,
    metrics,
    expected: Object.fromEntries(items.map((item) => [item.id, item.expectedThreadIds])),
    results,
  };
  const output = values.out ?? resolve("bench", "results", `retrieval-${engine}.json`);
  writeOut(output, `${JSON.stringify(run, null, 2)}\n`);
  process.stdout.write(renderTable(engine, metrics, preparationMilliseconds, overallMeanMilliseconds));
  process.stderr.write(`Wrote ${output}\n`);
}

runAsScript(import.meta.url, main, "Retrieval recall bench");
