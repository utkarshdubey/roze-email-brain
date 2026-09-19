// The derived FTS index is exercised through search_memory so these tests preserve its public output,
// while a forced-unavailable SQLite seam proves the literal scanner remains the complete fallback.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveBrainPaths, type SearchScope } from "../src/brain/storage.js";
import { searchIndexedMemory, type SqliteModule } from "../src/query/searchIndex.js";
import { directThreadId } from "../src/query/threadIds.js";
import { searchMemory } from "../src/query/memorySearch.js";
import type { Amounts, Group, Match } from "../src/query/toolContracts.js";

const sqlite = createRequire(import.meta.url)("node:sqlite") as SqliteModule;

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

test("the thread gate preserves line ranking outside all-scope any-term queries", () => {
  const { parent, root } = createSyntheticBrain();
  try {
    writeFileSync(join(root, "evidence", "threads", "aaaaaaaaaaaaaaaa.md"), "# Coordinated\nalpha first\nbeta last\n");
    writeFileSync(join(root, "people", "alpha.md"), "alpha beta\n");
    for (const [query, scope, match] of [
      ["alpha beta", "all", "all_terms"],
      ["alpha beta", "evidence", "any_term"],
      ["!!!", "all", "any_term"],
      ["!!!", "all", "all_terms"],
    ] as const) {
      const args = [root, query, scope, match, 10, "none", "ignore", "", ""] as const;
      assert.equal(searchMemory(...args, { engine: "fts" }), searchMemory(...args, { engine: "lines" }));
    }
    const args = [root, "alpha beta", "all", "any_term", 10, "none", "ignore", "", ""] as const;
    assert.equal(
      searchMemory(...args, { engine: "fts", threadStage: false }),
      searchMemory(...args, { engine: "lines" }),
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("terms spread across a thread outrank a short unrelated line", () => {
  const { parent, root } = createSyntheticBrain();
  try {
    writeFileSync(join(root, "evidence", "threads", "aaaaaaaaaaaaaaaa.md"),
      "# Coordinated plan\nalpha appears in the opening note\nbeta appears in the closing note\n");
    writeFileSync(join(root, "evidence", "threads", "bbbbbbbbbbbbbbbb.md"), "# Unrelated\nalpha\n");
    for (const id of ["cccccccccccccccc", "dddddddddddddddd", "eeeeeeeeeeeeeeee"]) {
      writeFileSync(join(root, "evidence", "threads", `${id}.md`), "# Filler\nunrelated words\n");
    }
    const lines = searchIndexedMemory(root, "alpha beta", "all", "any_term", 10, { threadStage: false });
    const threads = searchIndexedMemory(root, "alpha beta", "all", "any_term", 10);
    assert.equal(lines.hits[0]?.text, "alpha");
    assert.equal(threads.hits[0]?.path, "evidence/threads/aaaaaaaaaaaaaaaa.md");
    assert.equal(threads.total, lines.total);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("thread slots round up and the remainder deduplicates cited threads without sorting scores again", () => {
  const { parent, root } = createSyntheticBrain();
  try {
    writeFileSync(join(root, "evidence", "inbox-2026.md"),
      ["a", "b", "c", "d", "e", "f"].map((letter) =>
        `${letter.repeat(16)} | 2026-01-01 | sender@example.test | person | 1 msgs | Orchid launch | note`,
      ).join("\n"));
    writeFileSync(join(root, "people", "notes.md"), [
      "2099-01-01 Orchid launch [t:eeeeeeeeeeeeeeee 2099-01-01]",
      "2099-01-01 Orchid launch again [t:eeeeeeeeeeeeeeee 2099-01-01]",
      "2099-01-01 Orchid launch with no citation",
    ].join("\n"));
    const hits = searchIndexedMemory(root, "orchid launch", "all", "any_term", 6).hits;
    assert.deepEqual(hits.slice(0, 4).map((hit) => directThreadId(hit.path, hit.text)),
      ["a", "b", "c", "d"].map((letter) => letter.repeat(16)));
    assert.equal(hits.length, 6);
    assert.equal(hits.slice(4).filter((hit) => hit.text.includes("[t:eeeeeeeeeeeeeeee")).length, 1);
    assert.equal(hits.slice(4).filter((hit) => hit.text.includes("no citation")).length, 1);
    assert.ok(hits[4]!.score > hits[0]!.score, "the remainder's larger line score must not move it ahead of the stage");
    const rounded = searchIndexedMemory(root, "orchid launch", "all", "any_term", 5).hits;
    assert.deepEqual(rounded.slice(0, 4), hits.slice(0, 4), "ceil(2*5/3) still reserves four thread slots");
    const rendered = searchFts(root, "orchid launch", "all", "any_term", 6).split("\n").slice(1);
    assert.deepEqual(rendered, hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("inbox-only threads surface their row and retain person and auto terms", () => {
  const { parent, root } = createSyntheticBrain();
  try {
    writeFileSync(join(root, "evidence", "inbox-2026.md"), [
      "aaaaaaaaaaaaaaaa | 2026-01-01 | sender@example.test | auto | 1 msgs | Orchid | note",
      "bbbbbbbbbbbbbbbb | 2026-01-01 | sender@example.test | person | 1 msgs | Orchid | note",
    ].join("\n"));
    const hits = searchIndexedMemory(root, "orchid", "all", "any_term", 3).hits;
    assert.deepEqual(hits.map((hit) => hit.line), [2, 1]);
    assert.ok(hits.every((hit) => hit.path === "evidence/inbox-2026.md"));
    const database = new sqlite.DatabaseSync(resolveBrainPaths(root, ACCOUNT).searchIndexFile, { readOnly: true });
    try {
      assert.deepEqual(database.prepare("SELECT inbox_term FROM thread_documents ORDER BY id").all()
        .map((row) => row.inbox_term), [-5, 15]);
    } finally {
      database.close();
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a v1 index and a missing thread FTS table are rebuilt", () => {
  const { parent, root } = createSyntheticBrain();
  try {
    writeFileSync(join(root, "threads", "aaaaaaaaaaaaaaaa.md"), "alpha\nbeta\n");
    searchIndexedMemory(root, "alpha beta", "all", "any_term", 3);
    const file = resolveBrainPaths(root, ACCOUNT).searchIndexFile;
    for (const damage of [
      "UPDATE search_index_metadata SET value = '1' WHERE key = 'schema_version'; DROP TABLE thread_fts;",
      "DROP TABLE thread_fts;",
    ]) {
      const stale = new sqlite.DatabaseSync(file);
      stale.exec(damage);
      stale.close();
      assert.equal(searchIndexedMemory(root, "alpha beta", "all", "any_term", 3).hits[0]?.path,
        "threads/aaaaaaaaaaaaaaaa.md");
      const rebuilt = new sqlite.DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(rebuilt.prepare("SELECT value FROM search_index_metadata WHERE key = 'schema_version'").get()?.value, "2");
        assert.equal(rebuilt.prepare("SELECT count(*) AS n FROM thread_fts").get()?.n, 1);
        assert.equal(rebuilt.prepare("SELECT thread_id FROM search_rows WHERE text = 'alpha'").get()?.thread_id,
          "aaaaaaaaaaaaaaaa");
      } finally {
        rebuilt.close();
      }
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ROZE_SEARCH=lines selects line ranking and an invalid engine still throws", () => {
  const { parent, root } = createSyntheticBrain();
  const previous = process.env.ROZE_SEARCH;
  try {
    writeFileSync(join(root, "people", "notes.md"), "alpha beta\n");
    const args = [root, "alpha beta", "all", "any_term", 10, "none", "ignore", "", ""] as const;
    const expected = searchMemory(...args, { engine: "lines" });
    process.env.ROZE_SEARCH = "lines";
    assert.equal(searchMemory(...args), expected);
    process.env.ROZE_SEARCH = "invalid";
    assert.throws(() => searchMemory(...args), /ROZE_SEARCH must be literal, fts, or lines/u);
  } finally {
    if (previous === undefined) delete process.env.ROZE_SEARCH;
    else process.env.ROZE_SEARCH = previous;
    rmSync(parent, { recursive: true, force: true });
  }
});

test("thread documents use the same first-NUL text boundary as SQLite readers", () => {
  const { parent, root } = createSyntheticBrain();
  try {
    writeFileSync(join(root, "threads", "aaaaaaaaaaaaaaaa.md"), "visible\0hidden\n");
    searchIndexedMemory(root, "visible", "all", "any_term", 3);
    const database = new sqlite.DatabaseSync(resolveBrainPaths(root, ACCOUNT).searchIndexFile, { readOnly: true });
    try {
      assert.equal(database.prepare("SELECT text FROM search_rows WHERE thread_id IS NOT NULL").get()?.text, "visible");
      assert.equal(database.prepare("SELECT count(*) AS n FROM thread_fts WHERE thread_fts MATCH ?").get("hidden")?.n, 0);
      assert.equal(database.prepare("SELECT count(*) AS n FROM search_fts WHERE search_fts MATCH ?").get("hidden")?.n, 1);
    } finally {
      database.close();
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
