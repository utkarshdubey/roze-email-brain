// The derived FTS index is exercised through search_memory so these tests preserve its public output,
// while a forced-unavailable SQLite seam proves the literal scanner remains the complete fallback.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveBrainPaths, type SearchScope } from "../src/brain/storage.js";
import { searchMemory } from "../src/query/memorySearch.js";
import type { Amounts, Group, Match } from "../src/query/toolContracts.js";

const ACCOUNT = "searcher@example.test";

function createSyntheticBrain(): { parent: string; root: string } {
  const parent = mkdtempSync(join(tmpdir(), "roze-search-index-"));
  const root = join(parent, "brain");
  for (const directory of [
    "people",
    "organizations",
    "projects",
    "interests",
    "open_loops",
    "threads",
    "evidence/threads",
  ]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, "INDEX.md"), "# Synthetic brain\n");
  writeFileSync(join(root, "meta.json"), JSON.stringify({ generatedAt: "2026-09-01", userEmail: ACCOUNT }));
  return { parent, root };
}

function searchFts(
  root: string,
  query: string,
  scope: SearchScope,
  match: Match = "all_terms",
  limit = 20,
  groupBy: Group = "none",
  amounts: Amounts = "ignore",
  from = "",
  to = "",
  onIndexFallback: (message: string) => void = () => undefined,
): string {
  return searchMemory(root, query, scope, match, limit, groupBy, amounts, from, to, {
    engine: "fts",
    onIndexFallback,
  });
}

test("the first FTS search builds an account-scoped index and applies Porter stemming", () => {
  const { parent, root } = createSyntheticBrain();
  try {
    writeFileSync(
      join(root, "people", "planner.md"),
      "# Planner\nThe group planned a coastal migration. [t:aaaabbbbccccdddd 2026-08-20]\n",
    );
    const fallbackMessages: string[] = [];
    const result = searchFts(
      root,
      "planning migrations",
      "people",
      "all_terms",
      10,
      "none",
      "ignore",
      "",
      "",
      (message) => fallbackMessages.push(message),
    );

    assert.match(result, /people\/planner\.md:2: The group planned a coastal migration/u);
    assert.deepEqual(fallbackMessages, [], "a stem-only hit proves this did not silently use the literal scanner");
    const indexFile = resolveBrainPaths(root, ACCOUNT).searchIndexFile;
    assert.ok(existsSync(indexFile), "the index lives in the account cache");
    assert.ok(statSync(indexFile).size > 0, "the built index is not an empty marker");
    assert.equal(statSync(indexFile).mode & 0o777, 0o600, "the email-derived index is owner-readable only");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("FTS quotes every term so query-language punctuation and operators stay data", () => {
  const { parent, root } = createSyntheticBrain();
  try {
    writeFileSync(
      join(root, "people", "operators.md"),
      [
        "A quoted launch protocol is ready.",
        "The plan archive is ready.",
        "The planet archive is a decoy.",
        "alpha OR beta is printed as text.",
        "alpha appears alone.",
        "beta appears alone.",
        "NEAR project archive is printed as text.",
        "project archive appears without the marker.",
      ].join("\n") + "\n",
    );

    assert.match(searchFts(root, 'quoted "launch', "people"), /quoted launch protocol/u);
    const star = searchFts(root, "plan* archive", "people");
    assert.match(star, /The plan archive is ready/u);
    assert.doesNotMatch(star, /planet archive/u, "the asterisk never becomes an FTS prefix operator");
    const or = searchFts(root, "alpha OR beta", "people");
    assert.match(or, /alpha OR beta is printed as text/u);
    assert.doesNotMatch(or, /appears alone/u, "OR is a required literal token under all_terms");
    const near = searchFts(root, "NEAR(project archive", "people");
    assert.match(near, /NEAR project archive is printed as text/u);
    assert.doesNotMatch(near, /without the marker/u, "NEAR( cannot become an FTS proximity expression");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an indexed search cannot escape its requested scope", () => {
  const { parent, root } = createSyntheticBrain();
  try {
    writeFileSync(join(root, "people", "compass.md"), "A compass marker in a person view.\n");
    writeFileSync(join(root, "projects", "compass.md"), "A compass marker in a project view.\n");

    const people = searchFts(root, "compass marker", "people");
    assert.match(people, /people\/compass\.md/u);
    assert.doesNotMatch(people, /projects\/compass\.md/u);
    const projects = searchFts(root, "compass marker", "projects");
    assert.match(projects, /projects\/compass\.md/u);
    assert.doesNotMatch(projects, /people\/compass\.md/u);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("filename matches remain searchable without matching file content", () => {
  const { parent, root } = createSyntheticBrain();
  try {
    writeFileSync(join(root, "projects", "harbor-map.md"), "# Unrelated contents\n");
    const result = searchFts(root, "harbor map", "projects");
    assert.match(result, /projects\/harbor-map\.md:0: \(filename match\)/u);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("phrase and person bonuses survive BM25 ranking", () => {
  const { parent, root } = createSyntheticBrain();
  try {
    writeFileSync(
      join(root, "people", "ranking.md"),
      [
        "- 2026-08-20 Migration notes for the lantern checklist.",
        "- 2020-01-05 The lantern migration checklist was approved.",
      ].join("\n") + "\n",
    );
    assert.match(
      searchFts(root, "lantern migration checklist", "people").split("\n")[1] ?? "",
      /people\/ranking\.md:2/u,
      "the exact phrase outranks a newer row with the same terms",
    );

    writeFileSync(
      join(root, "evidence", "inbox-2026.md"),
      [
        "a000000000000000 | 2026-08-20 | robot@example.test | auto | 1 msgs | Quarterly planning | note",
        "b000000000000000 | 2020-01-05 | colleague@example.test | person | 1 msgs | Quarterly planning | note",
      ].join("\n") + "\n",
    );
    assert.match(
      searchFts(root, "quarterly planning", "thread_summaries").split("\n")[1] ?? "",
      /evidence\/inbox-2026\.md:2/u,
      "a person row outranks a newer automated row at equal textual relevance",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the per-file share is taken after FTS ranking", () => {
  const { parent, root } = createSyntheticBrain();
  try {
    const ordinaryRows = Array.from(
      { length: 11 },
      (_, index) => {
        const id = `a${String(index).padStart(15, "0")}`;
        const day = `2020-12-${String(20 - index).padStart(2, "0")}`;
        return `${id} | ${day} | none | Lantern task noted.`;
      },
    );
    writeFileSync(
      join(root, "threads", "threads-2020.md"),
      [
        ...ordinaryRows,
        "b000000000000000 | 2020-01-05 | resolved | The lantern migration checklist was completed.",
      ].join("\n") + "\n",
    );

    const result = searchFts(root, "lantern migration checklist", "thread_summaries", "any_term", 5);
    assert.match(result.split("\n")[1] ?? "", /threads\/threads-2020\.md:12/u, "the best row wins");
    assert.match(result, /^5 of 10 matches/u, "the header total reflects the year file's ten-row share");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("changed file stats rebuild the index even when meta.json is unchanged", () => {
  const { parent, root } = createSyntheticBrain();
  try {
    const memoryFile = join(root, "people", "notebook.md");
    writeFileSync(memoryFile, "The amber notebook records the first draft.\n");
    const initialSize = statSync(memoryFile).size;
    assert.match(searchFts(root, "amber notebook", "people"), /amber notebook/u);

    writeFileSync(memoryFile, "The cobalt notebook records a substantially revised second draft.\n");
    assert.notEqual(statSync(memoryFile).size, initialSize, "the file-size component of the fingerprint changed");
    assert.match(searchFts(root, "cobalt notebook", "people"), /cobalt notebook/u);
    assert.match(searchFts(root, "amber notebook", "people"), /^No literal matches/u, "stale rows were replaced");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("forced SQLite unavailability falls back to the unchanged literal scanner", () => {
  const { parent, root } = createSyntheticBrain();
  try {
    writeFileSync(join(root, "people", "fallback.md"), "A literal fallback marker.\n");
    const expected = searchMemory(root, "literal fallback", "people", "all_terms", 10, "none", "ignore", "", "", {
      engine: "literal",
    });
    const fallbackMessages: string[] = [];
    const actual = searchMemory(root, "literal fallback", "people", "all_terms", 10, "none", "ignore", "", "", {
      engine: "fts",
      sqlite: null,
      onIndexFallback: (message) => fallbackMessages.push(message),
    });
    const repeated = searchMemory(root, "literal fallback", "people", "all_terms", 10, "none", "ignore", "", "", {
      engine: "fts",
      sqlite: null,
      onIndexFallback: (message) => fallbackMessages.push(message),
    });

    assert.equal(actual, expected);
    assert.equal(repeated, expected);
    assert.equal(fallbackMessages.length, 1, "the verbose fallback notice is emitted once per process");
    assert.match(fallbackMessages[0] ?? "", /sqlite|index|literal/iu);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ROZE_SEARCH=literal selects the reference scanner without building an index", () => {
  const { parent, root } = createSyntheticBrain();
  const previous = process.env.ROZE_SEARCH;
  try {
    writeFileSync(join(root, "people", "reference.md"), "The literal engine remains available.\n");
    process.env.ROZE_SEARCH = "literal";
    assert.match(searchMemory(root, "literal engine", "people"), /people\/reference\.md/u);
    assert.equal(existsSync(resolveBrainPaths(root, ACCOUNT).searchIndexFile), false);
  } finally {
    if (previous === undefined) {
      delete process.env.ROZE_SEARCH;
    } else {
      process.env.ROZE_SEARCH = previous;
    }
    rmSync(parent, { recursive: true, force: true });
  }
});

test("tallies keep using the scanner even when FTS is selected and unavailable", () => {
  const { parent, root } = createSyntheticBrain();
  try {
    writeFileSync(
      join(root, "evidence", "inbox-2026.md"),
      [
        "a000000000000000 | 2026-08-01 | first@example.test | person | 1 msgs | Dispatch note | body",
        "b000000000000000 | 2026-08-02 | second@example.test | person | 1 msgs | Dispatch note | body",
      ].join("\n") + "\n",
    );
    const expected = searchMemory(
      root,
      "dispatch",
      "thread_summaries",
      "all_terms",
      10,
      "sender",
      "ignore",
      "",
      "",
      { engine: "literal" },
    );
    const fallbackMessages: string[] = [];
    const actual = searchMemory(
      root,
      "dispatch",
      "thread_summaries",
      "all_terms",
      10,
      "sender",
      "ignore",
      "",
      "",
      {
        engine: "fts",
        sqlite: null,
        onIndexFallback: (message) => fallbackMessages.push(message),
      },
    );

    assert.equal(actual, expected);
    assert.match(actual, /^2 matching threads/u);
    assert.deepEqual(fallbackMessages, [], "a tally never attempts to open SQLite");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
