// What ingestion keeps between runs so an interrupted build resumes instead of re-paying Gmail. Every file
// validates on read, so a damaged cache degrades to "not cached" rather than poisoning a build.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { BrainPaths } from "../brain/storage.js";
import {
  ensureDirectory,
  readJson,
  readTextFile,
  writeDataAtomically,
  writeFileAtomically,
} from "../shared/atomicFiles.js";
import type { EmailThread, MessageHeader } from "../types.js";

const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  date: z.string(),
  day: z.string(),
  timestamp: z.number(),
  fromName: z.string(),
  fromEmail: z.string(),
  to: z.string(),
  cc: z.string(),
  subject: z.string(),
  labels: z.array(z.string()),
  listId: z.string(),
  snippet: z.string(),
  body: z.string(),
});
const threadSchema: z.ZodType<EmailThread> = z.object({ id: z.string(), messages: z.array(messageSchema) });
const headerSchema: z.ZodType<MessageHeader> = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  timestamp: z.number().finite(),
  day: z.string(),
  fromName: z.string(),
  fromEmail: z.string().min(1),
  subject: z.string(),
  labels: z.array(z.string()),
  listId: z.string(),
  count: z.number().optional(),
  snippet: z.string().optional(),
});

const THREAD_ID = /^[0-9a-f]{8,}$/u;

/** Gmail ids become file names, so a traversal or separator in one must never reach the filesystem. */
function safeId(id: string): string {
  if (!id || id === "." || id === ".." || /[/\\\0]/u.test(id))
    throw new Error(`Unsafe Gmail cache id: ${JSON.stringify(id)}`);
  return id;
}

export function readCachedThread(id: string, paths: BrainPaths): EmailThread | undefined {
  const parsed = threadSchema.safeParse(readJson(join(paths.cachedThreadsDir, `${safeId(id)}.json`)));
  return parsed.success && parsed.data.id === id ? parsed.data : undefined;
}

export function writeCachedThread(thread: EmailThread, paths: BrainPaths): void {
  threadSchema.parse(thread);
  ensureDirectory(paths.cachedThreadsDir);
  writeDataAtomically(join(paths.cachedThreadsDir, `${safeId(thread.id)}.json`), thread);
}

export function readOnDemandThreadIds(paths: BrainPaths): string[] {
  return [
    ...new Set(
      (readTextFile(paths.cachedOnDemandFile) ?? "")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => THREAD_ID.test(line)),
    ),
  ];
}

export function rememberOnDemandThreadId(id: string, paths: BrainPaths): void {
  if (!THREAD_ID.test(id)) throw new Error(`Unsafe Gmail thread id: ${JSON.stringify(id)}`);
  if (!readOnDemandThreadIds(paths).includes(id)) {
    ensureDirectory(paths.cacheDir);
    appendFileSync(paths.cachedOnDemandFile, `${id}\n`, "utf8");
  }
}

/** Malformed rows are discarded together, so future runs do not rediscover them. */
export function readCachedHeaderRows(
  paths: BrainPaths,
  warn: (message: string) => void,
  repair = true,
): MessageHeader[] {
  const text = readTextFile(paths.cachedHeadersFile);
  if (text === undefined) return [];
  let malformed = 0;
  const rows = text.split(/\r?\n/u).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const result = headerSchema.safeParse(JSON.parse(line) as unknown);
      if (result.success) return [result.data];
    } catch {
      /* Count below. */
    }
    malformed += 1;
    return [];
  });
  if (malformed) {
    warn(`  warning: repairing ${malformed} malformed skim cache row(s)`);
    if (repair)
      writeFileAtomically(
        paths.cachedHeadersFile,
        rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
      );
  }
  return rows;
}

/** Only the coordinator appends, so concurrent workers cannot interleave JSONL bytes. */
export function appendHeaderRows(rows: readonly MessageHeader[], paths: BrainPaths): void {
  if (!rows.length) return;
  rows.forEach((row) => headerSchema.parse(row));
  ensureDirectory(paths.cacheDir);
  appendFileSync(paths.cachedHeadersFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}
