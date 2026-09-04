// The derived FTS5 search index lives in the account cache and mirrors every allowlisted published line.
// Its fingerprint makes an older generated brain usable without migration while keeping scope enforcement at
// the same file-glob boundary as the literal scanner.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import {
  VIEW_GLOBS_BY_SCOPE,
  readPublishedBrain,
  type BrainPaths,
  type SearchScope,
} from "../brain/storage.js";
import { ensureDirectory, readJson } from "../shared/atomicFiles.js";
import { cleanText } from "../shared/text.js";
import { listFiles } from "./memoryPaths.js";
import { linesOf, type Match } from "./toolContracts.js";

export type SearchEngine = "literal" | "fts";
export type SearchIndexKind = "view" | "inbox" | "full" | "summary" | "transaction" | "evidence";

export interface IndexedSearchHit {
  score: number;
  path: string;
  line: number;
  text: string;
}

export interface IndexedSearchResult {
  hits: IndexedSearchHit[];
  total: number;
  filesSearched: number;
}

type SqliteValue = string | number | bigint | null | Uint8Array;
type SqliteRow = Record<string, SqliteValue>;

export interface SqliteStatement {
  all(...values: SqliteValue[]): SqliteRow[];
  get(...values: SqliteValue[]): SqliteRow | undefined;
  run(...values: SqliteValue[]): unknown;
}

export interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

export interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

export interface SearchIndexOptions {
  /** `null` is an explicit test seam for runtimes where `node:sqlite` is unavailable. */
  sqlite?: SqliteModule | null;
}

export class SearchIndexUnavailableError extends Error {
  override readonly name = "SearchIndexUnavailableError";
}

interface IndexedFile {
  path: string;
  resolved: string;
  size: number;
  mtimeMs: number;
}

interface CurrentIndex {
  files: IndexedFile[];
  indexPath: string;
}

interface CachedCurrentIndex extends CurrentIndex {
  publicationMarker: string;
}

interface StoredSearchRow {
  rowid: number;
  path: string;
  line: number;
  kind: SearchIndexKind;
  day: string;
  person: boolean;
  text: string;
  rank: number;
}

const INDEX_FILE = "search.sqlite";
const INDEX_SCHEMA_VERSION = "1";
const DAY_IN_LINE = /\b20\d\d-\d\d-\d\d\b/gu;
const WORD = /[\p{L}\p{M}\p{N}_@.+-]+/gu;
const requireFromHere = createRequire(import.meta.url);
const cachedCurrentIndexes = new Map<string, CachedCurrentIndex>();

function sqliteWarningType(argumentsAfterWarning: readonly unknown[]): string {
  const first = argumentsAfterWarning[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "type" in first) {
    const type = (first as { type?: unknown }).type;
    return typeof type === "string" ? type : "";
  }
  return "";
}

/** Loading the built-in is the only operation whose one known experimental warning is suppressed. */
function loadSqlite(): SqliteModule {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
    const message = warning instanceof Error ? warning.message : warning;
    const isSqliteWarning =
      sqliteWarningType(rest) === "ExperimentalWarning" &&
      message === "SQLite is an experimental feature and might change at any time";
    if (!isSqliteWarning) {
      Reflect.apply(originalEmitWarning, process, [warning, ...rest]);
    }
  }) as typeof process.emitWarning;
  try {
    return requireFromHere("node:sqlite") as SqliteModule;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function resolveSqlite(options: SearchIndexOptions): SqliteModule {
  if (options.sqlite === null) {
    throw new SearchIndexUnavailableError("FTS search was disabled because node:sqlite is unavailable");
  }
  if (options.sqlite !== undefined) return options.sqlite;
  try {
    const sqlite = loadSqlite();
    if (typeof sqlite.DatabaseSync !== "function") throw new TypeError("node:sqlite has no DatabaseSync export");
    return sqlite;
  } catch (error) {
    throw new SearchIndexUnavailableError("This Node runtime does not provide the built-in SQLite database", {
      cause: error,
    });
  }
}

function generatedAt(paths: BrainPaths): string {
  const metadata = readJson(paths.metaFile);
  if (!metadata || typeof metadata !== "object" || !("generatedAt" in metadata)) return "";
  const value = (metadata as { generatedAt?: unknown }).generatedAt;
  return typeof value === "string" ? value : "";
}

function inventoryFiles(paths: BrainPaths): IndexedFile[] {
  return listFiles(paths.root, "all")
    .map(([path, resolved]) => {
      const stats = statSync(resolved);
      return { path, resolved, size: stats.size, mtimeMs: stats.mtimeMs };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function fingerprintFor(paths: BrainPaths, files: readonly IndexedFile[]): string {
  const fingerprint = createHash("sha256");
  fingerprint.update(`search-index-v${INDEX_SCHEMA_VERSION}\0${generatedAt(paths)}`);
  for (const file of files) {
    fingerprint.update(`\0${file.path}\0${file.size}\0${file.mtimeMs}`);
  }
  return fingerprint.digest("hex");
}

/** Complete published targets are immutable until generate swaps them and deletes their derived index. */
function publicationMarker(paths: BrainPaths): string | undefined {
  const metadata = readJson(paths.metaFile);
  if (!metadata || typeof metadata !== "object") return undefined;
  const build = "build" in metadata ? (metadata as { build?: unknown }).build : undefined;
  if (!build || typeof build !== "object" || !("complete" in build) || build.complete !== true) return undefined;
  const stats = statSync(paths.metaFile);
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

function closeQuietly(database: SqliteDatabase | undefined): void {
  if (!database) return;
  try {
    database.close();
  } catch {
    // The original index error is more useful than a second close failure.
  }
}

function currentIndexMatches(sqlite: SqliteModule, indexPath: string, fingerprint: string): boolean {
  if (!existsSync(indexPath)) return false;
  let database: SqliteDatabase | undefined;
  try {
    database = new sqlite.DatabaseSync(indexPath, { readOnly: true });
    const statement = database.prepare("SELECT value FROM search_index_metadata WHERE key = ?");
    const storedFingerprint = statement.get("fingerprint")?.value;
    const storedVersion = statement.get("schema_version")?.value;
    database.prepare("SELECT rowid FROM search_rows LIMIT 1").get();
    database.prepare("SELECT rowid FROM search_fts LIMIT 1").get();
    return storedFingerprint === fingerprint && storedVersion === INDEX_SCHEMA_VERSION;
  } catch {
    return false;
  } finally {
    closeQuietly(database);
  }
}

function kindForPath(path: string): SearchIndexKind {
  if (path.startsWith("evidence/inbox-")) return "inbox";
  if (path.startsWith("evidence/threads-")) return "full";
  if (path.startsWith("evidence/transactions-")) return "transaction";
  if (path.startsWith("evidence/threads/")) return "evidence";
  if (path.startsWith("threads/")) return "summary";
  return "view";
}

function newestDay(text: string): string {
  let newest = "";
  for (const match of text.matchAll(DAY_IN_LINE)) {
    if (match[0] > newest) newest = match[0];
  }
  return newest;
}

function createSchema(database: SqliteDatabase): void {
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE search_index_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE search_rows (
      rowid INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      line INTEGER NOT NULL,
      kind TEXT NOT NULL,
      day TEXT NOT NULL,
      person INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX search_rows_path ON search_rows(path);
    CREATE VIRTUAL TABLE search_fts USING fts5(text, tokenize = 'porter unicode61');
  `);
}

function populateIndex(
  database: SqliteDatabase,
  files: readonly IndexedFile[],
  fingerprint: string,
): void {
  const insertMetadata = database.prepare("INSERT INTO search_index_metadata(key, value) VALUES (?, ?)");
  const insertRow = database.prepare(
    "INSERT INTO search_rows(rowid, path, line, kind, day, person, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertFts = database.prepare("INSERT INTO search_fts(rowid, text) VALUES (?, ?)");
  let rowid = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const file of files) {
      const kind = kindForPath(file.path);
      for (const [index, text] of linesOf(readFileSync(file.resolved, "utf8")).entries()) {
        rowid += 1;
        const person = kind === "inbox" && text.toLowerCase().includes("| person |");
        insertRow.run(rowid, file.path, index + 1, kind, newestDay(text), Number(person), text);
        insertFts.run(rowid, text);
      }
    }
    insertMetadata.run("schema_version", INDEX_SCHEMA_VERSION);
    insertMetadata.run("fingerprint", fingerprint);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function replaceIndex(temporaryPath: string, indexPath: string): void {
  try {
    renameSync(temporaryPath, indexPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") throw error;
    rmSync(indexPath, { force: true });
    renameSync(temporaryPath, indexPath);
  }
}

function rebuildIndex(
  sqlite: SqliteModule,
  paths: BrainPaths,
  files: readonly IndexedFile[],
  fingerprint: string,
): string {
  ensureDirectory(paths.cacheDir);
  const indexPath = paths.searchIndexFile;
  const temporaryPath = join(paths.cacheDir, `${INDEX_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let database: SqliteDatabase | undefined;
  try {
    database = new sqlite.DatabaseSync(temporaryPath);
    chmodSync(temporaryPath, 0o600);
    createSchema(database);
    populateIndex(database, files, fingerprint);
    database.close();
    database = undefined;
    replaceIndex(temporaryPath, indexPath);
    return indexPath;
  } catch (error) {
    closeQuietly(database);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function ensureCurrentIndex(
  sqlite: SqliteModule,
  paths: BrainPaths,
  files: readonly IndexedFile[],
  fingerprint: string,
): string {
  const indexPath = paths.searchIndexFile;
  if (currentIndexMatches(sqlite, indexPath, fingerprint)) {
    chmodSync(indexPath, 0o600);
    return indexPath;
  }
  return rebuildIndex(sqlite, paths, files, fingerprint);
}

function currentIndex(sqlite: SqliteModule, paths: BrainPaths): CurrentIndex {
  const marker = publicationMarker(paths);
  const cached = cachedCurrentIndexes.get(paths.searchIndexFile);
  if (marker && cached?.publicationMarker === marker && existsSync(cached.indexPath)) return cached;

  const files = inventoryFiles(paths);
  const fingerprint = fingerprintFor(paths, files);
  const indexPath = ensureCurrentIndex(sqlite, paths, files, fingerprint);
  if (marker) {
    cachedCurrentIndexes.set(paths.searchIndexFile, { files, indexPath, publicationMarker: marker });
  } else {
    cachedCurrentIndexes.delete(paths.searchIndexFile);
  }
  return { files, indexPath };
}

/** The wildcard in every view glob names entries in one directory, so it can never consume a slash. */
function pathMatchesGlob(path: string, pattern: string): boolean {
  const wildcard = pattern.indexOf("*");
  if (wildcard === -1) return path === pattern;
  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return false;
  return !path.slice(prefix.length, path.length - suffix.length).includes("/");
}

function filesForScope(files: readonly IndexedFile[], scope: SearchScope): IndexedFile[] {
  const patterns = VIEW_GLOBS_BY_SCOPE[scope];
  return files.filter((file) => patterns.some((pattern) => pathMatchesGlob(file.path, pattern)));
}

/** Every user-derived fragment is a quoted FTS phrase; doubled quotes remain data, never syntax. */
function quoteFts(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

function termsFromQuery(query: string): string[] {
  return [...new Set([...query.matchAll(WORD)].map((match) => match[0].toLowerCase()))];
}

function matchExpression(terms: readonly string[], match: Match): string {
  const separator = match === "all_terms" ? " " : " OR ";
  return terms.map(quoteFts).join(separator);
}

function scopeSql(scope: SearchScope): { clause: string; values: string[] } {
  const patterns = VIEW_GLOBS_BY_SCOPE[scope];
  if (!patterns) throw new TypeError(`Unknown memory search scope: ${String(scope)}`);
  return {
    clause: patterns.map(() => "search_rows.path GLOB ?").join(" OR "),
    values: [...patterns],
  };
}

function numberValue(row: SqliteRow, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new TypeError(`Search index row has a non-numeric ${key}`);
}

function stringValue(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`Search index row has a non-text ${key}`);
  return value;
}

function searchKind(row: SqliteRow): SearchIndexKind {
  const kind = stringValue(row, "kind");
  if (["view", "inbox", "full", "summary", "transaction", "evidence"].includes(kind)) {
    return kind as SearchIndexKind;
  }
  throw new TypeError(`Search index row has an unknown kind: ${kind}`);
}

function storedRow(row: SqliteRow): StoredSearchRow {
  return {
    rowid: numberValue(row, "rowid"),
    path: stringValue(row, "path"),
    line: numberValue(row, "line"),
    kind: searchKind(row),
    day: stringValue(row, "day"),
    person: numberValue(row, "person") === 1,
    text: stringValue(row, "text"),
    rank: numberValue(row, "rank"),
  };
}

function readAllRows(database: SqliteDatabase, scope: SearchScope): StoredSearchRow[] {
  const filter = scopeSql(scope);
  const sql = `
    SELECT rowid, path, line, kind, day, person, text, 0 AS rank
    FROM search_rows
    WHERE ${filter.clause}
  `;
  return database.prepare(sql).all(...filter.values).map(storedRow);
}

function preparePhraseMatches(database: SqliteDatabase, phrase: string, scope: SearchScope): void {
  const filter = scopeSql(scope);
  database.exec("CREATE TEMP TABLE phrase_matches (rowid INTEGER PRIMARY KEY)");
  const insert = `
    INSERT INTO phrase_matches(rowid)
    SELECT search_rows.rowid
    FROM search_fts
    JOIN search_rows ON search_rows.rowid = search_fts.rowid
    WHERE search_fts MATCH ? AND (${filter.clause})
  `;
  database.prepare(insert).run(quoteFts(phrase), ...filter.values);
}

/** Matches the scanner's 1.5-point-per-year preference for recent rows. */
function recencyBonus(day: string): number {
  if (!day) return 0;
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return (year - 2000 + (month - 1) / 12 + (date - 1) / 372) * 1.5;
}

function scoreRow(row: StoredSearchRow, phraseMatches: ReadonlySet<number>): number {
  const relevance = -row.rank * 10;
  const phraseBonus = phraseMatches.has(row.rowid) ? 40 : 0;
  const senderBonus = row.kind === "inbox" ? (row.person ? 15 : -5) : 0;
  return 10 + relevance + phraseBonus + senderBonus + recencyBonus(row.day);
}

interface RankedHits {
  hits: IndexedSearchHit[];
  total: number;
}

/** SQLite ranks and applies each file's share before crossing the JS boundary; only the requested rows do. */
function readRankedFtsHits(
  database: SqliteDatabase,
  expression: string,
  scope: SearchScope,
  limit: number,
): RankedHits {
  const filter = scopeSql(scope);
  const sql = `
    WITH scored AS (
      SELECT search_rows.rowid, search_rows.path, search_rows.line,
             10 - bm25(search_fts, 1.0) * 10
             + CASE WHEN phrase_matches.rowid IS NULL THEN 0 ELSE 40 END
             + CASE WHEN search_rows.kind = 'inbox'
                    THEN CASE WHEN search_rows.person = 1 THEN 15 ELSE -5 END
                    ELSE 0 END
             + CASE WHEN search_rows.day = '' THEN 0 ELSE
                 ((CAST(substr(search_rows.day, 1, 4) AS REAL) - 2000)
                  + (CAST(substr(search_rows.day, 6, 2) AS REAL) - 1) / 12
                  + (CAST(substr(search_rows.day, 9, 2) AS REAL) - 1) / 372) * 1.5
               END AS score
      FROM search_fts
      JOIN search_rows ON search_rows.rowid = search_fts.rowid
      LEFT JOIN phrase_matches ON phrase_matches.rowid = search_rows.rowid
      WHERE search_fts MATCH ? AND (${filter.clause})
    ), ranked AS (
      SELECT rowid, path, line, score,
             row_number() OVER (PARTITION BY path ORDER BY score DESC, line) AS file_rank
      FROM scored
    ), shared AS (
      SELECT rowid, path, line, score
      FROM ranked
      WHERE file_rank <= CASE
        WHEN path GLOB 'threads/*'
          OR (path GLOB 'evidence/*.md' AND path NOT GLOB 'evidence/*/*.md') THEN 10
        ELSE 3
      END
    ), selected AS (
      SELECT rowid, path, line, score, count(*) OVER () AS total
      FROM shared
      ORDER BY score DESC, path, line
      LIMIT ?
    )
    SELECT selected.path, selected.line, selected.score, selected.total, search_rows.text
    FROM selected
    JOIN search_rows ON search_rows.rowid = selected.rowid
    ORDER BY selected.score DESC, selected.path, selected.line
  `;
  const rows = database.prepare(sql).all(expression, ...filter.values, limit);
  return {
    hits: rows.map((row) => ({
      score: numberValue(row, "score"),
      path: stringValue(row, "path"),
      line: numberValue(row, "line"),
      text: cleanText(stringValue(row, "text"), 500) || "(blank line)",
    })),
    total: rows.length ? numberValue(rows[0]!, "total") : 0,
  };
}

function pathMatches(path: string, terms: readonly string[], match: Match): boolean {
  const lower = path.toLowerCase();
  return match === "all_terms"
    ? terms.every((term) => lower.includes(term))
    : terms.some((term) => lower.includes(term));
}

/** Year lists hold one thread per line, so they retain the scanner's larger per-file share. */
function hitsPerFile(path: string): number {
  return path.startsWith("threads/") || /^evidence\/[^/]+\.md$/u.test(path) ? 10 : 3;
}

function rankedSharedHits(hits: IndexedSearchHit[]): IndexedSearchHit[] {
  hits.sort((left, right) =>
    right.score - left.score || left.path.localeCompare(right.path) || left.line - right.line,
  );
  const taken = new Map<string, number>();
  return hits.filter((hit) => {
    if (hit.line === 0) return true;
    const used = taken.get(hit.path) ?? 0;
    taken.set(hit.path, used + 1);
    return used < hitsPerFile(hit.path);
  });
}

function queryIndex(
  sqlite: SqliteModule,
  indexPath: string,
  query: string,
  scope: SearchScope,
  match: Match,
  limit: number,
  scopedFiles: readonly IndexedFile[],
): RankedHits {
  const terms = termsFromQuery(query);
  let database: SqliteDatabase | undefined;
  try {
    database = new sqlite.DatabaseSync(indexPath, { readOnly: true });
    let ranked: RankedHits;
    if (terms.length) {
      preparePhraseMatches(database, query, scope);
      ranked = readRankedFtsHits(database, matchExpression(terms, match), scope, limit);
    } else {
      const rows = match === "all_terms" ? readAllRows(database, scope) : [];
      const shared = rankedSharedHits(
        rows.map((row) => ({
          score: scoreRow(row, new Set()),
          path: row.path,
          line: row.line,
          text: cleanText(row.text, 500) || "(blank line)",
        })),
      );
      ranked = { hits: shared.slice(0, limit), total: shared.length };
    }
    const filenameHits: IndexedSearchHit[] = [];
    for (const file of scopedFiles) {
      if (pathMatches(file.path, terms, match)) {
        filenameHits.push({ score: 55, path: file.path, line: 0, text: "(filename match)" });
      }
    }
    const hits = [...ranked.hits, ...filenameHits]
      .sort((left, right) =>
        right.score - left.score || left.path.localeCompare(right.path) || left.line - right.line,
      )
      .slice(0, limit);
    return { hits, total: ranked.total + filenameHits.length };
  } finally {
    closeQuietly(database);
  }
}

export function searchIndexedMemory(
  brainDir: string,
  query: string,
  scope: SearchScope = "all",
  match: Match = "all_terms",
  limit = 20,
  options: SearchIndexOptions = {},
): IndexedSearchResult {
  try {
    const sqlite = resolveSqlite(options);
    const paths = readPublishedBrain(brainDir).paths;
    const { files, indexPath } = currentIndex(sqlite, paths);
    const scopedFiles = scope === "all" ? files : filesForScope(files, scope);
    const normalizedQuery = query.trim().replace(/\s+/gu, " ");
    const ranked = queryIndex(sqlite, indexPath, normalizedQuery, scope, match, limit, scopedFiles);
    return { ...ranked, filesSearched: scopedFiles.length };
  } catch (error) {
    if (error instanceof SearchIndexUnavailableError) throw error;
    throw new SearchIndexUnavailableError("The FTS search index could not be built or queried", { cause: error });
  }
}

/** Generation calls this after publication; a later prompt recreates the account-scoped derived data. */
export function invalidateSearchIndex(brain: string | BrainPaths): void {
  const paths = typeof brain === "string" ? readPublishedBrain(brain).paths : brain;
  const indexPath = paths.searchIndexFile;
  cachedCurrentIndexes.delete(indexPath);
  for (const path of [indexPath, `${indexPath}-journal`, `${indexPath}-shm`, `${indexPath}-wal`]) {
    rmSync(path, { force: true });
  }
}
