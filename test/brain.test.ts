import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PUBLISH_TARGETS, renameWithRetry, stageThenSwap } from "../src/brain/storage.js";
import { renderInterest, renderProject, writeConceptFiles } from "../src/brain/renderConcepts.js";
import { writeEntityFiles } from "../src/brain/renderEntities.js";
import { renderThreadAsMarkdown, writeEvidenceFiles } from "../src/brain/renderEvidence.js";
import { writeRootIndex } from "../src/brain/renderRootIndex.js";
import { writeThreadSummaries } from "../src/brain/renderThreadSummaries.js";
import { EntityRegistry } from "../src/memory/resolveEntities.js";
import type { Interest, Project } from "../src/types.js";
import { extraction, message, USER } from "./helpers.js";

test("evidence Markdown remains byte-for-byte compatible", () => {
  const root = mkdtempSync(join(tmpdir(), "roze-brain-"));
  try {
    const first = message("thread-1", "2026-08-28");
    Object.assign(first, {
      id: "m1",
      fromEmail: "alice@example.com",
      to: `Owner <${USER}>`,
      cc: "Bob <bob@example.com>",
      subject: "Launch",
      body: "Please review.",
    });
    const second = message("thread-1", "2026-08-29", USER, "Re: Launch");
    Object.assign(second, { id: "m2", to: "Alice <alice@example.com>", body: "Approved." });
    const thread = { id: "thread-1", messages: [first, second] };
    const expected = `# Launch
thread: thread-1  |  messages: 2  |  2026-08-28 → 2026-08-29
participants: alice@example.com, bob@example.com

## 2026-08-28T09:00-04:00  from: alice@example.com
to: me, bob@example.com

Please review.

## 2026-08-29T09:00-04:00  from: me
to: alice@example.com
subject: Re: Launch

Approved.
`;
    assert.equal(renderThreadAsMarkdown(thread, USER), expected);
    assert.equal(
      writeEvidenceFiles(
        [thread],
        [
          {
            id: "m9",
            threadId: "skim9",
            timestamp: 1,
            day: "2026-08-30",
            fromName: "Bob",
            fromEmail: "bob@example.com",
            subject: "Offer | details",
            labels: [],
            listId: "",
            snippet: "We are  pleased\nto offer",
          },
        ],
        USER,
        root,
      ).messages,
      2,
    );
    assert.match(
      readFileSync(join(root, "evidence", "inbox-2026.md"), "utf8"),
      /^skim9 \| 2026-08-30 \| bob@example\.com \| person \| 1 msgs \| Offer \/ details \| We are pleased to offer \| header$/mu,
    );
    assert.equal(readFileSync(join(root, "evidence", "threads", "thread-1.md"), "utf8"), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("entity, summary, concept, and root writers retain citation-bearing disk shapes", () => {
  const root = mkdtempSync(join(tmpdir(), "roze-writers-"));
  try {
    const registry = new EntityRegistry(USER);
    const slug = registry.createEntity("Example Co", "organization", "organization", "hello@example.com");
    const entity = registry.requireEntity(slug);
    Object.assign(entity, {
      firstSeen: "2026-08-30",
      lastSeen: "2026-08-30",
      threadIds: ["thread-new"],
      threadDays: { "thread-new": ["2026-08-30", "2026-08-30"] },
    });
    entity.items.push({
      threadId: "thread-new",
      day: "2026-08-30",
      text: "Review the launch plan.",
      kind: "loop",
      loopStatus: "open",
      label: "Launch",
    });
    assert.equal(writeEntityFiles(registry, root, "2026-09-02").openLoops, 1);
    assert.match(
      readFileSync(join(root, "open_loops", "INDEX.md"), "utf8"),
      /Example Co \(organizations\/example-co\.md\): \[Launch\] Review the launch plan\. \[t:thread-new 2026-08-30\]/u,
    );
    assert.ok(
      existsSync(join(root, "organizations", "example-co.md")) && !existsSync(join(root, "people", "example-co.md")),
      "organizations and people are separate directories",
    );
    const source = { id: "thread-new", messages: [message("thread-new", "2026-08-30")] };
    writeThreadSummaries(
      [extraction(source, { state: "open", stateNote: "waiting on Example Co" })],
      root,
      "2026-09-02",
    );
    assert.match(
      readFileSync(join(root, "threads", "INDEX.md"), "utf8"),
      /waiting on Example Co \[t:thread-new 2026-08-30\]/u,
    );
    const evidence = [{ threadId: "thread-new", day: "2026-08-30", reason: "Confirmed.", role: "goal" as const }];
    const project: Project = {
      name: "Launch",
      aliases: [],
      goal: "Ship",
      status: "active",
      outcome: "",
      people: [],
      organizations: ["Example Co"],
      firstSeen: "2026-08-30",
      lastActivity: "2026-08-30",
      evidence,
      narrative: "",
      tracks: [],
      related: [],
    };
    const interest: Interest = {
      topic: "Launches",
      kind: "subject",
      currentState: "active",
      summary: "Repeated launches.",
      firstSeen: "2026-08-30",
      lastSeen: "2026-08-30",
      engagement: "direct",
      evidence: [{ ...evidence[0]!, role: "active_signal" }],
      narrative: "",
      related: [],
    };
    assert.match(renderProject(project), /^# Launch\n\n- Goal: Ship/u);
    assert.match(renderInterest(interest), /Why: Repeated launches\. \[t:thread-new 2026-08-30\]/u);
    writeConceptFiles([project], [interest], {}, root);
    assert.match(readFileSync(join(root, "projects", "INDEX.md"), "utf8"), /Launch → projects\/launch\.md/u);
    assert.ok(existsSync(join(root, "concepts.json")));
    writeRootIndex(USER, { threads: 1, messages: 1, skimThreads: 0 }, root, "2026-09-02", ["- people/INDEX.md"]);
    assert.match(
      readFileSync(join(root, "INDEX.md"), "utf8"),
      /Memory for owner@example\.com, generated 2026-09-02 \(shape: facts\)/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function seedGeneration(root: string, prefix: string): void {
  mkdirSync(root, { recursive: true });
  for (const name of PUBLISH_TARGETS) {
    if (name.includes(".")) {
      writeFileSync(join(root, name), name === "INDEX.md" ? `${prefix}-index` : `{"generation":"${prefix}"}\n`);
      continue;
    }
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, `${prefix}.txt`), prefix);
  }
}

test("a mid-publish failure restores every old target and removes staging state", async () => {
  const root = mkdtempSync(join(tmpdir(), "roze-rollback-"));
  try {
    seedGeneration(root, "old");
    await assert.rejects(
      stageThenSwap(root, (staging) => seedGeneration(staging, "new"), {
        rename(source, destination) {
          if (source.includes(`.staging-${process.pid}`) && destination.endsWith("/people"))
            throw new Error("synthetic rename failure");
          renameSync(source, destination);
        },
        remove(path) {
          rmSync(path, { recursive: true, force: true });
        },
      }),
      /synthetic rename failure/u,
    );
    for (const name of PUBLISH_TARGETS.filter((target) => !target.includes(".")))
      assert.equal(readFileSync(join(root, name, "old.txt"), "utf8"), "old");
    assert.equal(readFileSync(join(root, "INDEX.md"), "utf8"), "old-index");
    assert.ok(!existsSync(join(root, `.staging-${process.pid}`)));
    assert.ok(!existsSync(join(root, `.rollback-${process.pid}`)));
    assert.deepEqual(PUBLISH_TARGETS.length, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("swap renames wait out transient Windows sharing violations but not real failures", () => {
  let calls = 0;
  const flaky = (): void => {
    calls += 1;
    if (calls < 3) {
      const error = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }
  };
  renameWithRetry("a", "b", flaky);
  assert.equal(calls, 3);
  assert.throws(
    () =>
      renameWithRetry("a", "b", () => {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }),
    /ENOENT/u,
  );
});
