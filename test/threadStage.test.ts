// The thread-stage benchmark is exercised against a tiny published brain and a copied production index.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { searchIndexedMemory } from "../src/query/searchIndex.js";
import {
  mergeThreadStageResults,
  prepareThreadStageIndex,
  searchThreadStage,
  type ThreadStageHit,
} from "../bench/threadStage.js";

const IDS = {
  spread: "aaaaaaaaaaaaaaaa",
  short: "bbbbbbbbbbbbbbbb",
  third: "cccccccccccccccc",
  fourth: "dddddddddddddddd",
  fifth: "eeeeeeeeeeeeeeee",
  skim: "ffffffffffffffff",
};

function rawThread(id: string, subject: string, body: readonly string[]): string {
  return [
    `# ${subject}`,
    `thread: ${id}  |  messages: 1  |  2026-01-02 → 2026-01-02`,
    "participants: sender@example.test",
    "",
    "## 2026-01-02T09:00-05:00  from: sender@example.test",
    "to: me",
    "",
    ...body,
    "",
  ].join("\n");
}

function createBrain(): { parent: string; root: string } {
  const parent = mkdtempSync(join(tmpdir(), "roze-thread-stage-test-"));
  const root = join(parent, "brain");
  for (const directory of [
    "people",
    "organizations",
    "projects",
    "interests",
    "open_loops",
    "concepts",
    "threads",
    "evidence/threads",
  ]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, "INDEX.md"), "# Fixture\n");
  writeFileSync(
    join(root, "meta.json"),
    JSON.stringify({ generatedAt: "2026-01-03", userEmail: "owner@example.test" }),
  );
  writeFileSync(join(root, "evidence", "threads", `${IDS.spread}.md`), rawThread(IDS.spread, "Coordinated plan", [
    "alpha appears in the opening note",
    "beta appears in the closing note",
  ]));
  writeFileSync(join(root, "evidence", "threads", `${IDS.short}.md`), rawThread(IDS.short, "Unrelated", ["alpha"]));
  writeFileSync(join(root, "evidence", "threads", `${IDS.third}.md`), rawThread(IDS.third, "Third", ["gamma"]));
  writeFileSync(join(root, "evidence", "threads", `${IDS.fourth}.md`), rawThread(IDS.fourth, "Fourth", ["delta"]));
  writeFileSync(join(root, "evidence", "threads", `${IDS.fifth}.md`), rawThread(IDS.fifth, "Fifth", ["epsilon"]));
  writeFileSync(
    join(root, "threads", "threads-2026.md"),
    [
      "# Thread summaries, 2026 (id | days | state | summary)",
      "",
      `${IDS.spread} | 2026-01-02 → 2026-01-02 | none | Coordinated work.`,
      `${IDS.short} | 2026-01-02 → 2026-01-02 | none | An unrelated note.`,
      `${IDS.third} | 2026-01-02 → 2026-01-02 | none | Third thread.`,
      `${IDS.fourth} | 2026-01-02 → 2026-01-02 | none | Fourth thread.`,
      `${IDS.fifth} | 2026-01-02 → 2026-01-02 | none | Fifth thread.`,
      `${IDS.skim} | 2026-01-02 → 2026-01-02 | none | Orchid follow-up.`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "evidence", "threads-2026.md"),
    [
      "# Full-read threads, 2026 (id | days | msgs | people | subject)",
      "",
      ...Object.values(IDS)
        .filter((id) => id !== IDS.skim)
        .map((id) => `${id} | 2026-01-02 → 2026-01-02 | 1 msgs | sender@example.test | Fixture`),
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "evidence", "inbox-2026.md"),
    [
      "# Skim-tier inbox threads, 2026",
      "",
      `${IDS.skim} | 2026-01-02 | colleague@example.test | person | 1 msgs | Orchidunique request | ` +
        "Please review the orchidunique item | header",
      "",
    ].join("\n"),
  );
  return { parent, root };
}

function treeSnapshot(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else {
        const stats = statSync(path);
        files.push(`${relative(root, path)}:${stats.size}:${stats.mtimeMs}`);
      }
    }
  };
  visit(root);
  return files;
}

function hit(id: string | null, label: string, threadStage = false): ThreadStageHit {
  return {
    score: 1,
    path: `views/${label}.md`,
    line: 1,
    text: label,
    threadIds: id ? [id] : [],
    threadStage,
    skim: false,
  };
}

test("thread documents coordinate terms, preserve skim inbox rows, and leave the brain unchanged", async () => {
  const { parent, root } = createBrain();
  try {
    const baseline = searchIndexedMemory(root, "alpha beta", "all", "any_term", 10, { threadStage: false });
    assert.equal(baseline.hits[0]?.text, "alpha", "today's line BM25 favors the shortest matching line");
    const before = treeSnapshot(root);
    const prepared = await prepareThreadStageIndex(root);
    try {
      const coordinated = searchThreadStage(prepared.database, "alpha beta", 10);
      assert.equal(coordinated[0]?.threadIds[0], IDS.spread, "terms on separate lines coordinate at thread level");

      const skim = searchThreadStage(prepared.database, "orchidunique", 10);
      assert.equal(skim[0]?.threadIds[0], IDS.skim);
      assert.match(skim[0]?.path ?? "", /^evidence\/inbox-2026\.md$/u);
      assert.match(skim[0]?.text ?? "", /person.*orchidunique/iu);
    } finally {
      prepared.cleanup();
    }
    assert.deepEqual(treeSnapshot(root), before, "the benchmark mutates only its temporary index copy");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the two-thirds split deduplicates remainder threads and keeps rows without a thread id", () => {
  const stage = [hit("t1", "s1", true), hit("t2", "s2", true), hit("t3", "s3", true), hit("t4", "s4", true)];
  const production = [
    hit("t1", "duplicate-stage"),
    hit("r1", "remainder-one"),
    hit("r1", "duplicate-remainder"),
    hit(null, "threadless"),
    hit("r2", "unused"),
  ];

  const merged = mergeThreadStageResults(stage, production, 6);
  assert.equal(merged.filter((row) => row.threadStage).length, 4, "ceil(2*6/3) slots come from threads");
  assert.deepEqual(merged.slice(4).map((row) => row.text), ["remainder-one", "threadless"]);
});
