// search_memory: ranked hits come from the derived FTS index when selected, while the literal scanner stays
// the reference and always owns grouped tallies. Both paths preserve the scope allowlist and rendered output;
// fixed-string query handling means no user input can become a regex or FTS operator.
import { readFileSync } from "node:fs";

import type { SearchScope } from "../brain/storage.js";
import { cleanText } from "../shared/text.js";
import { listFiles } from "./memoryPaths.js";
import { searchIndexedMemory, type SearchEngine, type SearchIndexOptions } from "./searchIndex.js";
import { capMiddle, linesOf, searchArguments, type Amounts, type Group, type Match } from "./toolContracts.js";

const DAY_IN_LINE = /\b(20\d\d)-(\d\d)-(\d\d)\b/gu;
const ROW_ID = /^([0-9a-f]{8,}) \| (\d{4}-\d{2}-\d{2})/u;
const SUBJECT_PREFIX = /^\s*((re|fw|fwd)\s*:\s*)+/iu;
const WORD = /[\p{L}\p{M}\p{N}_@.+-]+/gu;

/**
 * Per-year rows: inbox "id | day | from | person|auto | n | subject | snippet | body|header", full-read
 * "id | first → last | n | people | subject", summary "id | first → last | state | summary", transaction
 * "id | day | merchant | kind | amount | currency | sender | subject".
 */
type RowKind = "inbox" | "full" | "summary" | "transaction";

function rowKind(path: string): RowKind | undefined {
  if (path.startsWith("evidence/inbox-")) return "inbox";
  if (path.startsWith("evidence/threads-")) return "full";
  if (path.startsWith("evidence/transactions-")) return "transaction";
  if (path.startsWith("threads/")) return "summary";
  return undefined;
}

function senderCell(cells: readonly string[], kind: RowKind): string | undefined {
  if (kind === "inbox") return cells[2];
  if (kind === "full") return cells[3]?.split(",")[0]?.trim();
  if (kind === "transaction") return cells[6];
  return undefined;
}

function subjectCell(cells: readonly string[], kind: RowKind): string | undefined {
  if (kind === "inbox") return cells[5];
  if (kind === "full") return cells[4];
  if (kind === "transaction") return cells[7];
  return undefined;
}

/** The value a row contributes to a tally, or undefined when this row kind cannot answer it. */
function groupKey(cells: readonly string[], kind: RowKind, day: string, group: Group): string | undefined {
  if (group === "day") return day;
  if (group === "month") return day.slice(0, 7);
  if (group === "year") return day.slice(0, 4);
  if (group === "merchant") return kind === "transaction" ? cells[2]?.toLowerCase() : undefined;
  if (group === "kind") return kind === "transaction" ? cells[3] : undefined;
  if (group === "currency") return kind === "transaction" ? cells[5] : undefined;
  if (group === "sender") return senderCell(cells, kind);
  const subject = subjectCell(cells, kind);
  return subject ? subject.replace(SUBJECT_PREFIX, "").replace(/\s+/gu, " ").trim().toLowerCase() : undefined;
}

interface TalliedThread {
  kind: RowKind;
  key: string | undefined;
  day: string;
  amount?: number;
}

/** Most descriptive row wins when one thread appears in several per-year lists. */
const ROW_RANK: Record<RowKind, number> = { transaction: 4, inbox: 3, full: 2, summary: 1 };

/** One entry per matching thread, whichever per-year lists it holds, so nothing counts twice. */
function collectTalliedThreads(
  files: ReadonlyArray<[string, string]>,
  wanted: (text: string) => boolean,
  group: Group,
  from: string,
  to: string,
): Map<string, TalliedThread> {
  const threads = new Map<string, TalliedThread>();
  for (const [path, resolved] of files) {
    const kind = rowKind(path);
    if (!kind) continue;
    for (const source of linesOf(readFileSync(resolved, "utf8"))) {
      const row = ROW_ID.exec(source);
      if (!row || !wanted(source.toLowerCase()) || (from && row[2]! < from) || (to && row[2]! > to)) continue;
      const current = threads.get(row[1]!);
      if (current && ROW_RANK[current.kind] >= ROW_RANK[kind]) continue;
      const cells = source.split(" | ").map((cell) => cell.trim());
      threads.set(row[1]!, {
        kind,
        key: groupKey(cells, kind, row[2]!, group),
        day: row[2]!,
        amount: kind === "transaction" ? Number(cells[4]) : undefined,
      });
    }
  }
  return threads;
}

interface TallyGroup {
  count: number;
  sum: number;
  /** Counted threads that stated an amount; the rest are counted but not summed. */
  priced: number;
  example: string;
  latest: string;
}

interface Tally {
  groups: Map<string, TallyGroup>;
  rows: number;
  priced: number;
  total: number;
}

function foldIntoGroups(threads: ReadonlyMap<string, TalliedThread>, amounts: Amounts): Tally {
  const groups = new Map<string, TallyGroup>();
  let rows = 0;
  let priced = 0;
  let total = 0;
  for (const [threadId, row] of threads) {
    if (row.key === undefined) continue;
    rows += 1;
    const cite = `[t:${threadId} ${row.day}]`;
    const current = groups.get(row.key) ?? { count: 0, sum: 0, priced: 0, example: cite, latest: row.day };
    current.count += 1;
    if (amounts === "sum" && row.amount !== undefined && Number.isFinite(row.amount)) {
      current.sum += row.amount;
      current.priced += 1;
      priced += 1;
      total += row.amount;
    }
    // The example citation is the group's newest row, so it points at where things ended up.
    if (row.day > current.latest) {
      current.latest = row.day;
      current.example = cite;
    }
    groups.set(row.key, current);
  }
  return { groups, rows, priced, total };
}

const money = (value: number): string => `$${value.toFixed(2)}`;

function renderTally(tally: Tally, group: Group, amounts: Amounts, limit: number, quoted: string, scope: string) {
  const { groups, rows, priced, total } = tally;
  const bySize = (a: [string, TallyGroup], b: [string, TallyGroup]): number =>
    (amounts === "sum" ? b[1].sum - a[1].sum : 0) || b[1].count - a[1].count || a[0].localeCompare(b[0]);
  const top = [...groups].sort(bySize).slice(0, limit);
  const head =
    amounts === "sum"
      ? `${rows} matching threads for ${quoted} in ${scope}; ${priced} carry a stated total summing to ` +
        `${money(total)} (${rows - priced} without an amount); ${groups.size} distinct ${group}s, ` +
        `largest sum first (count | sum of totals | ${group} | latest example):`
      : `${rows} matching threads for ${quoted} in ${scope}, ${groups.size} distinct ${group}s; ` +
        `largest first (count | ${group} | latest example):`;
  const body = top.map(([key, value]) =>
    amounts === "sum"
      ? `${value.count} | ${money(value.sum)}` +
        `${value.priced < value.count ? ` (${value.priced} priced)` : ""} | ${key} | ${value.example}`
      : `${value.count} | ${key} | ${value.example}`,
  );
  return capMiddle([head, ...body].join("\n"));
}

interface Hit {
  score: number;
  path: string;
  line: number;
  text: string;
}

/** Year lists hold one thread per line, so more hits per file cost little and recall a lot. */
function hitsPerFile(path: string): number {
  return path.startsWith("threads/") || /^evidence\/[^/]+\.md$/u.test(path) ? 10 : 3;
}

/** 1.5 points per year, so newer rows outrank older ones at equal relevance ("where did it end"). */
function recencyBonus(line: string): number {
  return [...line.matchAll(DAY_IN_LINE)].reduce(
    (best, item) =>
      Math.max(best, (Number(item[1]) - 2000 + (Number(item[2]) - 1) / 12 + (Number(item[3]) - 1) / 372) * 1.5),
    0,
  );
}

function scoreLine(path: string, lower: string, terms: readonly string[], phrase: string): number {
  // People outrank automated senders in the header index; both stay searchable.
  const senderBoost = path.startsWith("evidence/inbox-") ? (lower.includes("| person |") ? 15 : -5) : 0;
  return (
    5 * terms.filter((term) => lower.includes(term)).length +
    10 +
    40 * Number(lower.includes(phrase)) +
    senderBoost +
    recencyBonus(lower)
  );
}

/**
 * Every matching line is scored first; a file's share is taken after ranking, so a year list with many
 * matches keeps its best rows rather than the first ten in file order (which, newest first, silently
 * dropped every older thread).
 */
function collectHits(
  files: ReadonlyArray<[string, string]>,
  wanted: (text: string) => boolean,
  terms: readonly string[],
  phrase: string,
): Hit[] {
  const hits: Hit[] = [];
  for (const [path, resolved] of files) {
    for (const [index, source] of linesOf(readFileSync(resolved, "utf8")).entries()) {
      const lower = source.toLowerCase();
      if (!wanted(lower)) continue;
      hits.push({
        score: scoreLine(path, lower, terms, phrase),
        path,
        line: index + 1,
        text: cleanText(source, 500) || "(blank line)",
      });
    }
    if (wanted(path.toLowerCase())) {
      hits.push({ score: 55, path, line: 0, text: "(filename match)" });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  const taken = new Map<string, number>();
  return hits.filter((hit) => {
    if (hit.line === 0) return true;
    const used = taken.get(hit.path) ?? 0;
    taken.set(hit.path, used + 1);
    return used < hitsPerFile(hit.path);
  });
}

function quoteQuery(query: string): string {
  return `'${query.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")}'`;
}

export function searchLiteralMemory(
  brainDir: string,
  query: string,
  scope: SearchScope = "all",
  match: Match = "all_terms",
  limit = 20,
  groupBy: Group = "none",
  amounts: Amounts = "ignore",
  from = "",
  to = "",
): string {
  const input = searchArguments.parse({
    query: query.trim().replace(/\s+/gu, " "),
    scope,
    match,
    limit,
    group_by: groupBy,
    amounts,
    from,
    to,
  });
  const phrase = input.query.toLowerCase();
  const terms = [...new Set([...input.query.matchAll(WORD)].map((item) => item[0].toLowerCase()))];
  const wanted = (text: string): boolean =>
    input.match === "all_terms"
      ? terms.every((term) => text.includes(term))
      : terms.some((term) => text.includes(term));
  const files = listFiles(brainDir, input.scope);
  const quoted = quoteQuery(input.query);

  // Counting each matching thread once rests frequency and spend answers on the whole index rather
  // than on the few threads the agent happened to read.
  if (input.group_by !== "none") {
    const period = input.from || input.to ? ` between ${input.from || "the beginning"} and ${input.to || "today"}` : "";
    const echo = quoted + period;
    const tally = foldIntoGroups(
      collectTalliedThreads(files, wanted, input.group_by, input.from, input.to),
      input.amounts,
    );
    if (!tally.rows) return `No rows match ${echo} in ${scope} (${files.length} files searched).`;
    return renderTally(tally, input.group_by, input.amounts, input.limit, echo, scope);
  }

  const hits = collectHits(files, wanted, terms, phrase);
  const selected = hits.slice(0, input.limit);
  if (!selected.length) return `No literal matches for ${quoted} in ${scope} (${files.length} files searched).`;
  return capMiddle(
    [
      `${selected.length} of ${hits.length} matches for ${quoted} in ${scope} (${files.length} files searched):`,
      ...selected.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`),
    ].join("\n"),
  );
}

export interface SearchMemoryOptions extends SearchIndexOptions {
  engine?: SearchEngine;
  /** The prompt path supplies its stderr trace here; benches may throw to reject a mislabeled fallback. */
  onIndexFallback?: (message: string) => void;
}

const DEFAULT_SEARCH_ENGINE: SearchEngine = "fts";
let reportedIndexFallback = false;

function selectedSearchEngine(options: SearchMemoryOptions): SearchEngine {
  const selected = options.engine ?? process.env.ROZE_SEARCH ?? DEFAULT_SEARCH_ENGINE;
  if (selected === "literal" || selected === "fts") return selected;
  throw new Error("ROZE_SEARCH must be either literal or fts");
}

function reportIndexFallbackOnce(error: unknown, report: SearchMemoryOptions["onIndexFallback"]): void {
  if (!report || reportedIndexFallback) return;
  reportedIndexFallback = true;
  const reason = error instanceof Error ? error.message : String(error);
  report(`FTS search is unavailable; using the literal scanner (${reason}).`);
}

/** Ranked search dispatches to FTS, but any tally and every failed index operation use the scanner unchanged. */
export function searchMemory(
  brainDir: string,
  query: string,
  scope: SearchScope = "all",
  match: Match = "all_terms",
  limit = 20,
  groupBy: Group = "none",
  amounts: Amounts = "ignore",
  from = "",
  to = "",
  options: SearchMemoryOptions = {},
): string {
  if (groupBy !== "none" || selectedSearchEngine(options) === "literal") {
    return searchLiteralMemory(brainDir, query, scope, match, limit, groupBy, amounts, from, to);
  }

  const input = searchArguments.parse({
    query: query.trim().replace(/\s+/gu, " "),
    scope,
    match,
    limit,
    group_by: groupBy,
    amounts,
    from,
    to,
  });
  const quoted = quoteQuery(input.query);
  try {
    const result = searchIndexedMemory(brainDir, input.query, input.scope, input.match, input.limit, {
      sqlite: options.sqlite,
    });
    if (!result.hits.length)
      return `No literal matches for ${quoted} in ${scope} (${result.filesSearched} files searched).`;
    return capMiddle(
      [
        `${result.hits.length} of ${result.total} matches for ${quoted} in ${scope} ` +
          `(${result.filesSearched} files searched):`,
        ...result.hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`),
      ].join("\n"),
    );
  } catch (error) {
    reportIndexFallbackOnce(error, options.onIndexFallback);
    return searchLiteralMemory(brainDir, query, scope, match, limit, groupBy, amounts, from, to);
  }
}
