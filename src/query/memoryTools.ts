// Running one memory tool call. Every tool validates its own arguments and returns a string, so a bad
// call becomes readable tool output the bounded agent can repair rather than an exception that ends the
// turn. Nothing here mutates the brain or the mailbox.
import { readFileSync } from "node:fs";

import { renderThreadAsMarkdown } from "../brain/renderEvidence.js";
import { readPublishedBrain, type SearchScope } from "../brain/storage.js";
import { readCachedThread, rememberOnDemandThreadId, writeCachedThread } from "../ingest/cache.js";
import { localizeThread } from "../shared/dates.js";
import type { EmailThread } from "../types.js";
import { resolveMemoryFile } from "./memoryPaths.js";
import { searchMemory, type SearchMemoryOptions } from "./memorySearch.js";
import {
  capMiddle,
  linesOf,
  readArguments,
  readEmailArguments,
  type Amounts,
  type Group,
  type Match,
} from "./toolContracts.js";

export type FetchThread = (id: string) => Promise<EmailThread>;

// read_memory

/** A read must hold a whole long thread; almost no evidence file exceeds this. */
const MAX_READ_CHARS = 24_000;

function linesWithinBudget(numbered: readonly string[]): number {
  let size = 0;
  for (let index = 0; index < numbered.length; index += 1) {
    size += numbered[index]!.length + 1;
    if (size > MAX_READ_CHARS) return index;
  }
  return numbered.length;
}

// Long reads keep the beginning and stop with a continuation hint: chronology beats a sampled end.
export function readMemory(brainDir: string, path: string, startLine = 1, maxLines = 250): string {
  const input = readArguments.parse({ path, start_line: startLine, max_lines: maxLines });
  const lines = linesOf(readFileSync(resolveMemoryFile(brainDir, input.path), "utf8"));
  if (input.start_line > lines.length)
    return `${path}: start_line ${startLine} is past the end (${lines.length} lines).`;
  const selected = lines.slice(input.start_line - 1, input.start_line - 1 + input.max_lines);
  const numbered = selected.map((line, index) => `${String(input.start_line + index).padStart(5, " ")} | ${line}`);
  const kept = linesWithinBudget(numbered);
  const lastLine = input.start_line + kept - 1;
  const tail =
    kept < numbered.length
      ? [
          `[read stops at line ${lastLine} of ${lines.length}; call read_memory with ` +
            `start_line=${lastLine + 1} to continue through the final message]`,
        ]
      : [];
  return [`${path} [lines ${startLine}-${lastLine} of ${lines.length}]`, ...numbered.slice(0, kept), ...tail].join(
    "\n",
  );
}

// read_email

/** A thread pulled on demand is cached and remembered, so the next generate extracts it for free. */
export async function readEmail(
  brainDir: string,
  threadId: string,
  fetchThread: FetchThread | undefined,
): Promise<string> {
  const { thread_id: id } = readEmailArguments.parse({ thread_id: threadId });
  const { paths, userEmail, timezone } = readPublishedBrain(brainDir);
  let thread = readCachedThread(id, paths);
  if (!thread) {
    if (!fetchThread)
      return "error: live Gmail access is unavailable; run `roze auth` and try again, or answer from the brain alone.";
    thread = await fetchThread(id);
    if (thread.id !== id || !thread.messages.length) return `error: Gmail has no readable thread ${id}`;
    writeCachedThread(thread, paths);
    rememberOnDemandThreadId(id, paths);
  }
  return capMiddle(renderThreadAsMarkdown(localizeThread(thread, timezone), userEmail));
}

// Dispatch

export async function executeTool(
  name: string,
  value: unknown,
  brainDir: string,
  fetchThread?: FetchThread,
  searchOptions: SearchMemoryOptions = {},
): Promise<string> {
  const args = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  try {
    if (name === "search_memory")
      return searchMemory(
        brainDir,
        String(args.query ?? ""),
        args.scope as SearchScope,
        args.match as Match,
        args.limit as number,
        args.group_by as Group,
        args.amounts as Amounts,
        args.from as string,
        args.to as string,
        searchOptions,
      );
    if (name === "read_memory")
      return readMemory(brainDir, String(args.path ?? ""), args.start_line as number, args.max_lines as number);
    if (name === "read_email") return await readEmail(brainDir, String(args.thread_id ?? ""), fetchThread);
    return `error: unknown memory tool ${name}`;
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
