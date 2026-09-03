// One line per full-read thread, filed by year, plus an index inlining the threads still left open.
import { join } from "node:path";
import { clearMarkdownDirectory, pushToYear, writeFileAtomically, writeYearFiles } from "../shared/atomicFiles.js";
import { loopIsStale } from "../shared/dates.js";
import type { ThreadExtraction } from "../types.js";
import { resolveBrainPaths } from "./storage.js";

export function writeThreadSummaries(extractions: readonly ThreadExtraction[], root: string, asOfDay: string) {
  const directory = resolveBrainPaths(root).threadsDir;
  clearMarkdownDirectory(directory);

  const byYear = new Map<string, string[]>();
  const newestFirst = [...extractions].sort((left, right) => right.lastDay.localeCompare(left.lastDay));
  for (const extraction of newestFirst) {
    const state = extraction.state === "none" ? extraction.state : `${extraction.state}: ${extraction.stateNote}`;
    pushToYear(
      byYear,
      extraction.lastDay.slice(0, 4),
      `${extraction.threadId} | ${extraction.firstDay} → ${extraction.lastDay} | ${state} | ${extraction.summary}`,
    );
  }
  writeYearFiles(directory, "threads", (year) => `# Thread summaries, ${year} (id | days | state | summary)`, byYear);

  const open = extractions
    .filter((row) => row.state === "open" && !loopIsStale(row.lastDay, asOfDay))
    .sort((left, right) => right.lastDay.localeCompare(left.lastDay));
  const index = [
    "# Thread summaries index",
    "",
    "One summary per full-read thread in threads/threads-<year>.md; raw thread in evidence/threads/<id>.md.",
    "",
    ...[...byYear.keys()]
      .sort()
      .reverse()
      .map((year) => `- threads-${year}.md — ${byYear.get(year)?.length ?? 0} threads`),
    "",
    "## Threads left open in the last year (newest first)",
  ];
  if (!open.length) {
    index.push("- none");
  } else {
    for (const row of open.slice(0, 40)) {
      index.push(`- ${row.lastDay} ${row.stateNote} [t:${row.threadId} ${row.lastDay}]`);
    }
  }
  writeFileAtomically(join(directory, "INDEX.md"), `${index.join("\n")}\n`);
  return { threadsSummarized: extractions.length, openThreads: open.length };
}
