// Checks every generated citation against a raw evidence message heading. Offline; never reads caches or
// credentials.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseArgs } from "node:util";

import { resolveBrainPaths } from "../src/brain/storage.js";
import { resolveMemoryFile } from "../src/query/memoryPaths.js";
import { runAsScript } from "./script.js";

interface Location {
  view: string;
  thread_id: string;
  message_date: string;
}

const CITATION = /\[t:([^\s\]]+)\s+(\d{4}-\d{2}-\d{2})\]/gu;

function markdownFiles(root: string): string[] {
  const files: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".cache") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    }
  }
  visit(root);
  return files.sort();
}

/** The retrieval allowlist is the one place a cited id becomes a path, so it can never escape evidence/. */
function readEvidence(root: string, threadId: string): string | undefined {
  try {
    return readFileSync(resolveMemoryFile(root, `evidence/threads/${threadId}.md`), "utf8");
  } catch {
    return undefined;
  }
}

function validateCitations(brainRoot?: string) {
  const paths = resolveBrainPaths(brainRoot);
  const files = markdownFiles(paths.root);
  const missing: Location[] = [];
  const invalid: Location[] = [];
  const evidence = new Map<string, string>();
  let checked = 0;
  for (const view of files) {
    const viewPath = relative(paths.root, view).split(sep).join("/");
    for (const match of readFileSync(view, "utf8").matchAll(CITATION)) {
      const location: Location = { view: viewPath, thread_id: match[1]!, message_date: match[2]! };
      checked += 1;
      const source = evidence.get(location.thread_id) ?? readEvidence(paths.root, location.thread_id);
      if (source === undefined) {
        missing.push(location);
        continue;
      }
      evidence.set(location.thread_id, source);
      const heading = `## ${location.message_date}T`;
      if (!source.split("\n").some((line) => line.startsWith(heading))) invalid.push(location);
    }
  }
  return {
    ok: !missing.length && !invalid.length,
    view_files: files.length,
    citations_checked: checked,
    distinct_evidence_threads_checked: evidence.size,
    missing_thread_count: missing.length,
    invalid_message_date_count: invalid.length,
    missing_threads: missing,
    invalid_message_dates: invalid,
  };
}

runAsScript(
  import.meta.url,
  async () => {
    try {
      const { values } = parseArgs({ options: { brain: { type: "string" } }, strict: true });
      const report = validateCitations(values.brain);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.ok ? 0 : 1;
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
      );
      process.exitCode = 1;
    }
  },
  "Citation validation",
);
