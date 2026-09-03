// `INDEX.md`, the brain's front door: coverage, layout, how to navigate down to evidence, and the citation
// contract. Written last, once the sections it lists have been rendered.
import { ensureDirectory, writeFileAtomically } from "../shared/atomicFiles.js";
import type { EvidenceCounts } from "./renderEvidence.js";
import { resolveBrainPaths } from "./storage.js";

/** bodyThreads is absent in brains built before it existed. */
type RootIndexCounts = Pick<EvidenceCounts, "threads" | "messages" | "skimThreads"> &
  Partial<Pick<EvidenceCounts, "bodyThreads">>;

export function writeRootIndex(
  userEmail: string,
  counts: RootIndexCounts,
  root: string,
  generatedDay: string,
  sections: readonly string[],
  buildStatus = "Build status: complete.",
): void {
  const lines = [
    "# Brain index",
    "",
    `Memory for ${userEmail}, generated ${generatedDay} (shape: facts).`,
    `${counts.threads} full-read threads / ${counts.messages} messages, ` +
      `${counts.skimThreads} skim-tier threads (not extracted; ${counts.bodyThreads ?? 0} of them with raw ` +
      "bodies in evidence/threads/).",
    buildStatus,
    "",
    "## Layout (one directory per rubric concept, plus the evidence they cite)",
    ...sections,
    "- threads/INDEX.md — one-line summary and state per full-read thread.",
    "- evidence/INDEX.md — per-year thread lists; evidence/threads/<id>.md is the raw thread, both sides. " +
      "This is the only authoritative layer.",
    "",
    "## How to navigate",
    "- people, organizations, projects, interests, and open_loops are derived views: use them to find " +
      "thread ids, then verify in evidence/threads/<id>.md before answering.",
    "- Use scope=thread_summaries to find thread ids/state; scope=evidence for literal full-text search of raw mail.",
    "- Memory tools are non-mutating and cannot access caches, credentials, raw JSONL, or the process environment.",
    "- Every day and timestamp is in the user's own timezone (the offset their sent mail carries), " +
      "whatever zone the sender used.",
    "",
    "## Citations",
    "Every claim in an answer must cite thread ids as [t:<thread_id> <YYYY-MM-DD>]. The date must match " +
      "an actual message heading in that thread. If the brain has no evidence for something, say so instead " +
      "of guessing.",
  ];
  const paths = resolveBrainPaths(root);
  ensureDirectory(paths.root);
  writeFileAtomically(paths.indexFile, `${lines.join("\n")}\n`);
}
