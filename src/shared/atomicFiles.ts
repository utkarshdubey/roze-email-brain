// Every write the brain makes goes through a temporary file in the same directory, renamed into place, so
// a reader never observes a partial one. Also the two file readers, .env loading, and the yearly views.

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

export function ensureDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function writeFileAtomically(path: string, text: string, mode?: number): void {
  const parent = dirname(path);
  ensureDirectory(parent);
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, text, { encoding: "utf8", ...(mode === undefined ? {} : { mode }) });
    renameSync(temporary, path);
    if (mode !== undefined) {
      chmodSync(path, mode);
    }
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch (cleanup) {
      if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") throw cleanup;
    }
    throw error;
  }
}

export function writeDataAtomically(path: string, value: unknown): void {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) throw new TypeError("value is not JSON-serializable");
  writeFileAtomically(path, `${json}\n`);
}

/** A missing file is a legitimate empty state for every cache and config the brain reads. */
export function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function readJson(path: string): unknown | undefined {
  const text = readTextFile(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

const ENV_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

function parseEnvironmentValue(raw: string): string {
  const value = raw.trim();
  const single = /^'([^']*)'(?:\s+#.*)?$/.exec(value);
  const double = /^"((?:\\.|[^"\\])*)"(?:\s+#.*)?$/.exec(value);
  if (single?.[1] !== undefined) return single[1];
  if (double?.[1] !== undefined)
    return double[1].replace(/\\([nrt"\\])/g, (_match, escaped: string) => ENV_ESCAPES[escaped] ?? escaped);
  return value.replace(/\s+#.*$/, "").trim();
}

/** Existing process values win; .env fills only the missing keys. */
export function loadEnvironmentFile(file = resolve(process.cwd(), ".env")): void {
  const text = readTextFile(file);
  if (text === undefined) return;
  for (const source of text.replace(/^\uFEFF/, "").split(/\r\n?|\n/)) {
    const line = source.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    const key = match?.[1];
    const raw = match?.[2];
    if (key !== undefined && raw !== undefined && process.env[key] === undefined)
      process.env[key] = parseEnvironmentValue(raw);
  }
}

/** Byte-stable: heading line, blank line, rows. */
export function writeYearFiles(
  directory: string,
  prefix: string,
  heading: (year: string) => string,
  byYear: ReadonlyMap<string, string[]>,
): void {
  for (const [year, lines] of byYear)
    writeFileAtomically(join(directory, `${prefix}-${year}.md`), `${heading(year)}\n\n${lines.join("\n")}\n`);
}

export function pushToYear(byYear: Map<string, string[]>, year: string, line: string): void {
  const lines = byYear.get(year);
  if (lines) {
    lines.push(line);
  } else {
    byYear.set(year, [line]);
  }
}

/** Stale Markdown from an earlier generation must not survive beside a new index. */
export function clearMarkdownDirectory(directory: string): void {
  ensureDirectory(directory);
  for (const entry of readdirSync(directory, { withFileTypes: true }))
    if (entry.isFile() && entry.name.endsWith(".md")) {
      unlinkSync(join(directory, entry.name));
    }
}
