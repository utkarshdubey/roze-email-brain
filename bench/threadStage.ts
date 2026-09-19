// Offline benchmark for the pre-registered thread-first retrieval design. The production index remains the
// source of truth; the line baseline and frozen thread arm are compared with production using a disposable copy.
process.env.ROZE_SKIP_ENV = "1";

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import { directThreadId } from "../src/query/threadIds.js";

import {
  computeRetrievalDocumentFrequencies,
  cutRetrievalQuestion,
  loadRetrievalItems,
  selectRetrievalIdf3Terms,
  splitRetrievalSpreadSample,
  threadIdsInSearchHit,
  type RetrievalItem,
} from "./retrievalGold.js";
import { runAsScript, writeOut } from "./script.js";

type SqliteValue = string | number | bigint | null | Uint8Array;
type SqliteRow = Record<string, SqliteValue>;

export interface ThreadStageStatement {
  all(...values: SqliteValue[]): SqliteRow[];
  get(...values: SqliteValue[]): SqliteRow | undefined;
  run(...values: SqliteValue[]): unknown;
}

export interface ThreadStageDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): ThreadStageStatement;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => ThreadStageDatabase;
}

interface IndexedRow {
  rowid: number;
  path: string;
  line: number;
  kind: string;
  person: boolean;
  text: string;
}

interface ThreadDocument {
  id: string;
  subject: string;
  header: string[];
  summary: string[];
  body: string[];
  inboxRows: IndexedRow[];
  rawRows: IndexedRow[];
  rows: IndexedRow[];
  personInbox: boolean;
  hasInbox: boolean;
}

export interface ThreadStageHit {
  score: number;
  path: string;
  line: number;
  text: string;
  threadIds: string[];
  threadStage: boolean;
  skim: boolean;
}

export interface ThreadStageCorpus {
  documentCount: number;
  duplicateIdsByThread: ReadonlyMap<string, ReadonlySet<string>>;
  skimThreadIds: ReadonlySet<string>;
}

interface SearchResultLike {
  hits: Array<{ score: number; path: string; line: number; text: string }>;
  total: number;
}

export interface PreparedThreadStageIndex {
  database: ThreadStageDatabase;
  corpus: ThreadStageCorpus;
  cleanup(): void;
  productionSearch(query: string, limit: number): SearchResultLike;
  lineSearch(query: string, limit: number): SearchResultLike;
}

type QueryMode = "question" | "idf3";
type Arm = "fts" | "merged" | "thread-only" | "production";

interface ArmSearch {
  hits: ThreadStageHit[];
  milliseconds: number;
}

interface RankPair {
  strict: number | null;
  duplicateTolerant: number | null;
}

interface QuestionRun {
  id: string;
  question: string;
  query: string;
  queryTerms: string[];
  expectedThreadIds: string[];
  ranks: Record<Arm, RankPair>;
  productionMatchesMerged: boolean;
  over6000: Record<Arm, boolean>;
  milliseconds: Record<Arm, number>;
  threadStageSlots: Record<Arm, { skim: number; total: number }>;
}

const ARMS: Arm[] = ["fts", "merged", "thread-only", "production"];
const WORD = /[\p{L}\p{M}\p{N}_@.+-]+/gu;
const BOOTSTRAP_RESAMPLES = 2_000;
const requireFromHere = createRequire(import.meta.url);

function numberValue(row: SqliteRow, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new TypeError(`Thread-stage row has a non-numeric ${key}`);
}

function stringValue(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`Thread-stage row has a non-text ${key}`);
  return value;
}

function loadSqlite(): SqliteModule {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
    const message = warning instanceof Error ? warning.message : warning;
    const type = typeof rest[0] === "string" ? rest[0] : "";
    if (type !== "ExperimentalWarning" || message !== "SQLite is an experimental feature and might change at any time") {
      Reflect.apply(originalEmitWarning, process, [warning, ...rest]);
    }
  }) as typeof process.emitWarning;
  try {
    return requireFromHere("node:sqlite") as SqliteModule;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function cleanText(value: string, limit = 500): string {
  return Array.from(value.split(/\s+/u).filter(Boolean).join(" ")).slice(0, limit).join("");
}

function quoteFts(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

export function termsFromThreadStageQuery(query: string): string[] {
  return [...new Set([...query.matchAll(WORD)].map((match) => match[0].toLowerCase()))];
}

function subjectFromListRow(row: IndexedRow): string {
  const columns = row.text.split("|").map((part) => part.trim());
  if (row.kind === "inbox") return columns[5] ?? "";
  if (row.kind === "full") return columns[4] ?? "";
  return "";
}

function newDocument(id: string): ThreadDocument {
  return {
    id,
    subject: "",
    header: [],
    summary: [],
    body: [],
    inboxRows: [],
    rawRows: [],
    rows: [],
    personInbox: false,
    hasInbox: false,
  };
}

function firstMessageSignature(rows: readonly IndexedRow[]): string | null {
  const ordered = [...rows].sort((left, right) => left.line - right.line);
  const headingIndex = ordered.findIndex((row) => row.text.startsWith("## "));
  if (headingIndex === -1) return null;
  const heading = /^##\s+(.+?)\s+from:\s*(.+?)\s*$/u.exec(ordered[headingIndex]!.text);
  if (!heading) return null;
  const recipients: string[] = [];
  for (const row of ordered.slice(headingIndex + 1)) {
    if (!row.text.trim()) break;
    if (row.text.startsWith("to:")) {
      recipients.push(...row.text.slice(3).split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
    }
  }
  return JSON.stringify([
    heading[1]!.trim(),
    heading[2]!.trim().toLowerCase(),
    [...new Set(recipients)].sort(),
  ]);
}

/** Adds only benchmark tables to an already-disposable database copy. */
export function buildThreadStageIndex(database: ThreadStageDatabase): ThreadStageCorpus {
  const indexedRows = database
    .prepare("SELECT rowid, path, line, kind, person, text FROM search_rows ORDER BY rowid")
    .all()
    .map((row): IndexedRow => ({
      rowid: numberValue(row, "rowid"),
      path: stringValue(row, "path"),
      line: numberValue(row, "line"),
      kind: stringValue(row, "kind"),
      person: numberValue(row, "person") === 1,
      text: stringValue(row, "text"),
    }));
  const documents = new Map<string, ThreadDocument>();
  for (const row of indexedRows) {
    const id = directThreadId(row.path, row.text);
    if (!id) continue;
    const document = documents.get(id) ?? newDocument(id);
    documents.set(id, document);
    document.rows.push(row);
    if (row.kind === "evidence") {
      document.rawRows.push(row);
      document.body.push(row.text);
      if (!document.subject && row.text.startsWith("# ")) document.subject = row.text.slice(2);
    } else if (row.kind === "summary") {
      document.summary.push(row.text);
    } else if (["full", "inbox", "transaction"].includes(row.kind)) {
      document.header.push(row.text);
    }
    if (!document.subject) document.subject = subjectFromListRow(row);
    if (row.kind === "inbox") {
      document.hasInbox = true;
      document.personInbox ||= row.person;
      document.inboxRows.push(row);
    }
  }

  database.exec(`
    DROP TABLE IF EXISTS thread_fts;
    DROP TABLE IF EXISTS thread_documents;
    CREATE TABLE thread_documents (
      rowid INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      inbox_term INTEGER NOT NULL,
      skim INTEGER NOT NULL
    );
    CREATE TABLE thread_rows (
      thread_id TEXT NOT NULL,
      rowid INTEGER NOT NULL,
      PRIMARY KEY (thread_id, rowid)
    );
    CREATE INDEX thread_rows_rowid ON thread_rows(rowid);
    CREATE VIRTUAL TABLE thread_fts USING fts5(
      subject,
      header,
      summary,
      body,
      content = '',
      tokenize = 'porter unicode61'
    );
  `);
  const insertDocument = database.prepare(
    "INSERT INTO thread_documents(rowid, id, inbox_term, skim) VALUES (?, ?, ?, ?)",
  );
  const insertRow = database.prepare("INSERT INTO thread_rows(thread_id, rowid) VALUES (?, ?)");
  const insertFts = database.prepare(
    "INSERT INTO thread_fts(rowid, subject, header, summary, body) VALUES (?, ?, ?, ?, ?)",
  );
  const skimThreadIds = new Set<string>();
  const signatureGroups = new Map<string, Set<string>>();
  database.exec("BEGIN IMMEDIATE");
  try {
    let rowid = 0;
    for (const document of documents.values()) {
      rowid += 1;
      const skim = document.rawRows.length === 0;
      if (skim) skimThreadIds.add(document.id);
      const body = document.body.length ? document.body : document.inboxRows.slice(0, 1).map((row) => row.text);
      const inboxTerm = document.hasInbox ? (document.personInbox ? 15 : -5) : 0;
      insertDocument.run(rowid, document.id, inboxTerm, Number(skim));
      insertFts.run(
        rowid,
        document.subject,
        document.header.join("\n"),
        document.summary.join("\n"),
        body.join("\n"),
      );
      for (const row of document.rows) insertRow.run(document.id, row.rowid);
      const signature = firstMessageSignature(document.rawRows);
      if (signature) {
        const ids = signatureGroups.get(signature) ?? new Set<string>();
        ids.add(document.id);
        signatureGroups.set(signature, ids);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  const duplicateIdsByThread = new Map<string, ReadonlySet<string>>();
  for (const ids of signatureGroups.values()) {
    for (const id of ids) duplicateIdsByThread.set(id, ids);
  }
  return { documentCount: documents.size, duplicateIdsByThread, skimThreadIds };
}

function lineHit(row: SqliteRow, threadId: string, skim: boolean, threadStageScore: number): ThreadStageHit {
  return {
    score: threadStageScore,
    path: stringValue(row, "path"),
    line: numberValue(row, "line"),
    text: cleanText(stringValue(row, "text")) || "(blank line)",
    threadIds: [threadId],
    threadStage: true,
    skim,
  };
}

function fallbackLine(database: ThreadStageDatabase, threadId: string): SqliteRow | undefined {
  const base = `
    SELECT search_rows.path, search_rows.line, search_rows.text
    FROM thread_rows
    JOIN search_rows ON search_rows.rowid = thread_rows.rowid
    WHERE thread_rows.thread_id = ?`;
  return (
    database.prepare(`${base} AND search_rows.kind = 'summary' ORDER BY search_rows.rowid LIMIT 1`).get(threadId) ??
    database.prepare(`${base} ORDER BY search_rows.rowid LIMIT 1`).get(threadId)
  );
}

/** Returns one production-scored line per thread, ordered by the frozen thread score. */
export function searchThreadStage(
  database: ThreadStageDatabase,
  query: string,
  limit: number,
): ThreadStageHit[] {
  const normalizedQuery = query.trim().replace(/\s+/gu, " ");
  const terms = termsFromThreadStageQuery(normalizedQuery);
  if (!terms.length || limit <= 0) return [];
  const expression = terms.map(quoteFts).join(" OR ");
  const threads = database
    .prepare(`
      SELECT thread_documents.id,
             thread_documents.skim,
             10 - 10 * bm25(thread_fts, 1.0, 1.0, 1.0, 1.0) + thread_documents.inbox_term AS score
      FROM thread_fts
      JOIN thread_documents ON thread_documents.rowid = thread_fts.rowid
      WHERE thread_fts MATCH ?
      ORDER BY score DESC, thread_documents.id
      LIMIT ?
    `)
    .all(expression, limit);
  database.exec("DROP TABLE IF EXISTS temp.thread_stage_phrase_matches");
  database.exec("CREATE TEMP TABLE thread_stage_phrase_matches (rowid INTEGER PRIMARY KEY)");
  database
    .prepare(`
      INSERT INTO thread_stage_phrase_matches(rowid)
      SELECT rowid FROM search_fts WHERE search_fts MATCH ?
    `)
    .run(quoteFts(normalizedQuery));
  const bestLine = database.prepare(`
    SELECT search_rows.path, search_rows.line, search_rows.text,
           10 - bm25(search_fts, 1.0) * 10
           + CASE WHEN thread_stage_phrase_matches.rowid IS NULL THEN 0 ELSE 40 END
           + CASE WHEN search_rows.kind = 'inbox'
                  THEN CASE WHEN search_rows.person = 1 THEN 15 ELSE -5 END
                  ELSE 0 END
           + CASE WHEN search_rows.day = '' THEN 0 ELSE
               ((CAST(substr(search_rows.day, 1, 4) AS REAL) - 2000)
                + (CAST(substr(search_rows.day, 6, 2) AS REAL) - 1) / 12
                + (CAST(substr(search_rows.day, 9, 2) AS REAL) - 1) / 372) * 1.5
             END AS line_score
    FROM search_fts
    JOIN search_rows ON search_rows.rowid = search_fts.rowid
    JOIN thread_rows ON thread_rows.rowid = search_rows.rowid
    LEFT JOIN thread_stage_phrase_matches ON thread_stage_phrase_matches.rowid = search_rows.rowid
    WHERE search_fts MATCH ? AND thread_rows.thread_id = ?
    ORDER BY line_score DESC, search_rows.path, search_rows.line
    LIMIT 1
  `);
  return threads.flatMap((thread) => {
    const id = stringValue(thread, "id");
    const score = numberValue(thread, "score");
    const skim = numberValue(thread, "skim") === 1;
    const row = bestLine.get(expression, id) ?? fallbackLine(database, id);
    return row ? [lineHit(row, id, skim, score)] : [];
  });
}

export function mergeThreadStageResults(
  threadHits: readonly ThreadStageHit[],
  productionHits: readonly ThreadStageHit[],
  limit: number,
): ThreadStageHit[] {
  const threadSlots = Math.ceil((2 * limit) / 3);
  const selected = threadHits.slice(0, threadSlots);
  const shown = new Set(selected.flatMap((hit) => hit.threadIds.map((id) => id.toLowerCase())));
  const merged = [...selected];
  for (const hit of productionHits) {
    if (merged.length >= limit) break;
    const ids = hit.threadIds.map((id) => id.toLowerCase());
    if (ids.some((id) => shown.has(id))) continue;
    merged.push(hit);
    for (const id of ids) shown.add(id);
  }
  return merged;
}

function productionHits(result: SearchResultLike): ThreadStageHit[] {
  return result.hits.map((hit) => ({
    ...hit,
    threadIds: threadIdsInSearchHit(hit.path, hit.text).map((id) => id.toLowerCase()),
    threadStage: false,
    skim: false,
  }));
}

export async function prepareThreadStageIndex(brain: string): Promise<PreparedThreadStageIndex> {
  const [{ readPublishedBrain }, { searchIndexedMemory }] = await Promise.all([
    import("../src/brain/storage.js"),
    import("../src/query/searchIndex.js"),
  ]);
  const paths = readPublishedBrain(brain).paths;
  searchIndexedMemory(brain, "thread stage index probe", "all", "any_term", 1, { threadStage: false });
  if (!existsSync(paths.searchIndexFile)) throw new Error("production search index was not created");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "roze-thread-stage-"));
  const temporaryIndex = join(temporaryDirectory, "search.sqlite");
  copyFileSync(paths.searchIndexFile, temporaryIndex);
  const database = new (loadSqlite().DatabaseSync)(temporaryIndex);
  try {
    const corpus = buildThreadStageIndex(database);
    return {
      database,
      corpus,
      productionSearch: (query, limit) => searchIndexedMemory(brain, query, "all", "any_term", limit),
      lineSearch: (query, limit) => searchIndexedMemory(brain, query, "all", "any_term", limit, { threadStage: false }),
      cleanup: () => {
        database.close();
        rmSync(temporaryDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    database.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function searchFts(index: PreparedThreadStageIndex, query: string, limit: number): ArmSearch {
  const started = performance.now();
  const hits = productionHits(index.lineSearch(query, limit)).slice(0, limit);
  return { hits, milliseconds: performance.now() - started };
}

function searchProduction(index: PreparedThreadStageIndex, query: string, limit: number, slots: number): ArmSearch {
  const started = performance.now();
  const hits = productionHits(index.productionSearch(query, limit));
  const milliseconds = performance.now() - started;
  for (const hit of hits.slice(0, slots)) {
    hit.threadStage = true;
    const id = directThreadId(hit.path, hit.text);
    hit.threadIds = id ? [id] : [];
    hit.skim = id !== null && index.corpus.skimThreadIds.has(id);
  }
  return { hits, milliseconds };
}

function searchThreadOnly(index: PreparedThreadStageIndex, query: string, limit: number): ArmSearch {
  const started = performance.now();
  const hits = searchThreadStage(index.database, query, limit);
  return { hits, milliseconds: performance.now() - started };
}

function searchMerged(index: PreparedThreadStageIndex, query: string, limit: number): ArmSearch {
  const started = performance.now();
  const threadHits = searchThreadStage(index.database, query, Math.ceil((2 * limit) / 3));
  let requested = limit;
  let result = index.lineSearch(query, requested);
  let hits = mergeThreadStageResults(threadHits, productionHits(result), limit);
  while (hits.length < limit && result.hits.length < result.total) {
    requested = Math.min(result.total, Math.max(requested * 2, requested + limit));
    result = index.lineSearch(query, requested);
    hits = mergeThreadStageResults(threadHits, productionHits(result), limit);
  }
  return { hits, milliseconds: performance.now() - started };
}

function tolerantGoldIds(item: RetrievalItem, corpus: ThreadStageCorpus): Set<string> {
  const ids = new Set(item.expectedThreadIds.map((id) => id.toLowerCase()));
  for (const id of [...ids]) {
    for (const duplicate of corpus.duplicateIdsByThread.get(id) ?? []) ids.add(duplicate);
  }
  return ids;
}

function rankFor(hits: readonly ThreadStageHit[], expected: ReadonlySet<string>): number | null {
  const index = hits.findIndex((hit) => hit.threadIds.some((id) => expected.has(id.toLowerCase())));
  return index === -1 ? null : index + 1;
}

function renderedCharacters(hits: readonly ThreadStageHit[]): number {
  return hits.reduce((sum, hit) => sum + `${hit.path}:${hit.line}: ${cleanText(hit.text)}\n`.length, 0);
}

function queryFor(item: RetrievalItem, mode: QueryMode, frequencies: ReturnType<typeof computeRetrievalDocumentFrequencies>) {
  if (mode === "question") {
    const query = cutRetrievalQuestion(item.question);
    return { query, terms: termsFromThreadStageQuery(query) };
  }
  const terms = selectRetrievalIdf3Terms(item.question, frequencies);
  return { query: terms.join(" "), terms };
}

function runQuestion(
  item: RetrievalItem,
  mode: QueryMode,
  frequencies: ReturnType<typeof computeRetrievalDocumentFrequencies>,
  limit: number,
  index: PreparedThreadStageIndex,
): QuestionRun {
  const query = queryFor(item, mode, frequencies);
  const fts = searchFts(index, query.query, limit);
  const merged = searchMerged(index, query.query, limit);
  const searches: Record<Arm, ArmSearch> = {
    fts,
    merged,
    production: searchProduction(index, query.query, limit, merged.hits.filter((hit) => hit.threadStage).length),
    "thread-only": searchThreadOnly(index, query.query, limit),
  };
  const strict = new Set(item.expectedThreadIds.map((id) => id.toLowerCase()));
  const tolerant = tolerantGoldIds(item, index.corpus);
  const ranks = Object.fromEntries(
    ARMS.map((arm) => [
      arm,
      {
        strict: rankFor(searches[arm].hits, strict),
        duplicateTolerant: rankFor(searches[arm].hits, tolerant),
      },
    ]),
  ) as Record<Arm, RankPair>;
  return {
    id: item.id,
    question: item.question,
    query: query.query,
    queryTerms: query.terms,
    expectedThreadIds: item.expectedThreadIds,
    ranks,
    productionMatchesMerged: JSON.stringify(searches.production.hits) === JSON.stringify(searches.merged.hits),
    over6000: Object.fromEntries(
      ARMS.map((arm) => [arm, renderedCharacters(searches[arm].hits) > 6_000]),
    ) as Record<Arm, boolean>,
    milliseconds: Object.fromEntries(ARMS.map((arm) => [arm, searches[arm].milliseconds])) as Record<Arm, number>,
    threadStageSlots: Object.fromEntries(
      ARMS.map((arm) => {
        const stage = searches[arm].hits.filter((hit) => hit.threadStage);
        return [arm, { skim: stage.filter((hit) => hit.skim).length, total: stage.length }];
      }),
    ) as Record<Arm, { skim: number; total: number }>,
  };
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function bootstrapVisibleDelta(
  ranks: readonly (number | null)[],
  baseline: readonly (number | null)[],
): [number, number] {
  if (!ranks.length) return [0, 0];
  const deltas = ranks.map((rank, index) => Number(rank !== null) - Number(baseline[index] !== null));
  const random = mulberry32(1);
  const means: number[] = [];
  for (let sample = 0; sample < BOOTSTRAP_RESAMPLES; sample += 1) {
    let sum = 0;
    for (let index = 0; index < deltas.length; index += 1) {
      sum += deltas[Math.floor(random() * deltas.length)]!;
    }
    means.push(sum / deltas.length);
  }
  means.sort((left, right) => left - right);
  return [means[Math.floor(0.025 * means.length)]! * 100, means[Math.ceil(0.975 * means.length) - 1]! * 100];
}

function summarize(questions: readonly QuestionRun[], arm: Arm) {
  const strictRanks = questions.map((question) => question.ranks[arm].strict);
  const tolerantRanks = questions.map((question) => question.ranks[arm].duplicateTolerant);
  const metric = (ranks: readonly (number | null)[]) => ({
    visible: ranks.filter((rank) => rank !== null).length / ranks.length,
    mrr: ranks.reduce<number>((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0) / ranks.length,
  });
  const skim = questions.reduce((sum, question) => sum + question.threadStageSlots[arm].skim, 0);
  const stage = questions.reduce((sum, question) => sum + question.threadStageSlots[arm].total, 0);
  return {
    strict: metric(strictRanks),
    duplicateTolerant: metric(tolerantRanks),
    skimThreadStageShare: stage ? skim / stage : null,
    over6000: questions.filter((question) => question.over6000[arm]).length,
    p95Milliseconds: questions.map((question) => question.milliseconds[arm]).sort((a, b) => a - b)[
      Math.ceil(questions.length * 0.95) - 1
    ] ?? 0,
    meanMilliseconds: questions.reduce((sum, question) => sum + question.milliseconds[arm], 0) / questions.length,
  };
}

function comparisons(questions: readonly QuestionRun[]) {
  const baseline = questions.map((question) => question.ranks.fts.strict);
  return Object.fromEntries(
    ARMS.map((arm) => {
      const ranks = questions.map((question) => question.ranks[arm].strict);
      const wins = ranks.filter((rank, index) => rank !== null && baseline[index] === null).length;
      const losses = ranks.filter((rank, index) => rank === null && baseline[index] !== null).length;
      return [
        arm,
        {
          gainPoints: ((ranks.filter((rank) => rank !== null).length - baseline.filter((rank) => rank !== null).length) /
            ranks.length) * 100,
          ci95Points: bootstrapVisibleDelta(ranks, baseline),
          won: wins,
          lost: losses,
        },
      ];
    }),
  ) as Record<Arm, { gainPoints: number; ci95Points: [number, number]; won: number; lost: number }>;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function renderReport(
  questionCount: number,
  mode: QueryMode,
  limit: number,
  metrics: Record<Arm, ReturnType<typeof summarize>>,
  paired: ReturnType<typeof comparisons>,
  differences: number,
): string {
  const lines = [
    `# Thread-stage retrieval (${mode}, limit ${limit}, n=${questionCount})`,
    "",
    "| arm | strict visible | strict MRR | duplicate-tolerant visible | duplicate-tolerant MRR | skim stage slots | >6000 chars | mean ms | p95 ms |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const arm of ARMS) {
    const row = metrics[arm];
    lines.push(
      `| ${arm} | ${percent(row.strict.visible)} | ${row.strict.mrr.toFixed(4)} | ` +
        `${percent(row.duplicateTolerant.visible)} | ${row.duplicateTolerant.mrr.toFixed(4)} | ` +
        `${row.skimThreadStageShare === null ? "n/a" : percent(row.skimThreadStageShare)} | ` +
        `${row.over6000} | ${row.meanMilliseconds.toFixed(2)} | ${row.p95Milliseconds.toFixed(2)} |`,
    );
  }
  lines.push(
    "",
    "| arm vs fts | strict visible gain (points) | paired bootstrap 95% CI | won | lost |",
    "|---|---:|---:|---:|---:|",
  );
  for (const arm of ARMS) {
    const row = paired[arm];
    lines.push(
      `| ${arm} | ${row.gainPoints.toFixed(1)} | [${row.ci95Points[0].toFixed(1)}, ${row.ci95Points[1].toFixed(1)}] | ` +
        `${row.won} | ${row.lost} |`,
    );
  }
  lines.push(
    "",
    `Production vs merged: ${differences}/${questionCount} questions differ (complete ordered hits, including scores).`,
    differences ? "Deviations: production differs from the frozen merged arm." : "Deviations: none.",
    "",
  );
  return lines.join("\n");
}

function parsePositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function pathIsInside(parent: string, child: string): boolean {
  const offset = relative(parent, child);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      brain: { type: "string" },
      "query-mode": { type: "string" },
      limit: { type: "string" },
      sample: { type: "string" },
      "exclude-sample": { type: "string" },
      out: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 1 || !values.brain) {
    throw new Error(
      "Usage: tsx bench/threadStage.ts <gold.json> --brain <dir> [--query-mode question|idf3] " +
        "[--limit 10|20] [--sample N | --exclude-sample N] [--out results.json]",
    );
  }
  if (values.sample && values["exclude-sample"]) {
    throw new Error("--sample and --exclude-sample are mutually exclusive");
  }
  const source = resolve(positionals[0]!);
  const brain = resolve(values.brain);
  const mode = values["query-mode"] ?? "idf3";
  if (mode !== "question" && mode !== "idf3") throw new Error("--query-mode must be question or idf3");
  const limit = Number(values.limit ?? 10);
  if (limit !== 10 && limit !== 20) throw new Error("--limit must be 10 or 20");
  const sampleSize = parsePositiveInteger(values.sample, "--sample");
  const excludedSize = parsePositiveInteger(values["exclude-sample"], "--exclude-sample");
  const output = resolve(values.out ?? join("bench", "results", "thread-stage.json"));
  if (pathIsInside(brain, output)) throw new Error("--out must not write inside the brain directory");
  const loaded = loadRetrievalItems(source);
  if (!loaded.length) throw new Error("question set has no items with expected citation thread ids");
  const splitSize = sampleSize ?? excludedSize;
  const split = splitSize === undefined ? undefined : splitRetrievalSpreadSample(loaded, splitSize);
  const items = sampleSize !== undefined ? split!.selected : excludedSize !== undefined ? split!.remainder : loaded;

  process.stderr.write(`Preparing disposable thread index for ${basename(brain)}...\n`);
  const index = await prepareThreadStageIndex(brain);
  try {
    const documents = index.database.prepare("SELECT text FROM search_rows ORDER BY rowid").all().map((row) =>
      stringValue(row, "text"),
    );
    const frequencies = computeRetrievalDocumentFrequencies(documents);
    const questions: QuestionRun[] = [];
    for (const [position, item] of items.entries()) {
      questions.push(runQuestion(item, mode, frequencies, limit, index));
      process.stderr.write(`\rSearched ${position + 1}/${items.length}`);
    }
    process.stderr.write("\n");
    const metrics = Object.fromEntries(ARMS.map((arm) => [arm, summarize(questions, arm)])) as Record<
      Arm,
      ReturnType<typeof summarize>
    >;
    const paired = comparisons(questions);
    const differences = questions.filter((question) => !question.productionMatchesMerged).length;
    const run = {
      source,
      brain,
      ranAt: new Date().toISOString(),
      config: {
        queryMode: mode,
        limit,
        sample: sampleSize ?? null,
        excludeSample: excludedSize ?? null,
        questions: questions.length,
        threadDocuments: index.corpus.documentCount,
        bootstrapResamples: BOOTSTRAP_RESAMPLES,
        bootstrapSeed: 1,
      },
      metrics,
      comparisons: paired,
      productionDifferences: differences,
      deviations: differences ? ["production differs from the frozen merged arm"] : [],
      questions,
    };
    writeOut(output, `${JSON.stringify(run, null, 2)}\n`);
    process.stdout.write(renderReport(questions.length, mode, limit, metrics, paired, differences));
    process.stderr.write(`Wrote ${output}\n`);
  } finally {
    index.cleanup();
  }
}

runAsScript(import.meta.url, main, "Thread-stage bench");
