import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeConceptFiles } from "../src/brain/renderConcepts.js";
import { rejectWhatTheModelGetsWrong } from "../src/concepts/applyGates.js";
import {
  finishConceptTrace,
  traceConceptReview,
  traceJudgeProposals,
} from "../src/concepts/conceptTrace.js";
import { collectClusterJudgments } from "../src/concepts/judgeClusters.js";
import { applyProjectReview } from "../src/concepts/reviewConcepts.js";
import { resolveMemoryFile } from "../src/query/memoryPaths.js";
import type { ProjectEvidenceRole, ThreadCluster } from "../src/types.js";
import { thread, USER } from "./helpers.js";

const threads = [
  thread("aaaaaaaaaaaa0001", ["2025-01-01"]),
  thread("bbbbbbbbbbbb0002", ["2025-02-01"]),
  thread("cccccccccccc0003", ["2025-03-01"]),
  thread("dddddddddddd0004", ["2025-04-01"]),
  thread("eeeeeeeeeeee0005", ["2025-05-01"]),
  thread("ffffffffffff0006", ["2025-06-01"]),
];
const cluster: ThreadCluster = {
  key: "entity-learning",
  anchor: "Learning",
  aliases: [],
  kind: "entity",
  threadIds: threads.map((row) => row.id),
};
const sourceRef = (threadIndex: number): string =>
  `${threads[threadIndex]!.id}::${threads[threadIndex]!.messages[0]!.day}`;
const evidence = (first: number, second: number) => [
  { source_ref: sourceRef(first), role: "goal" as ProjectEvidenceRole, reason: "A goal was stated." },
  { source_ref: sourceRef(second), role: "outcome" as ProjectEvidenceRole, reason: "The effort advanced." },
];
const proposal = (name: string, first: number, second: number) => ({
  name,
  aliases: [],
  goal: "Complete the learning effort",
  status: "unknown" as const,
  outcome: "",
  people: [],
  organizations: [],
  evidence: evidence(first, second),
});

test("every judge proposal renders its gate, dedupe, review, and final-file fate", () => {
  const references = Object.fromEntries(
    threads.map((row, index) => [sourceRef(index), { threadId: row.id, day: row.messages[0]!.day }]),
  );
  const document: Parameters<typeof collectClusterJudgments>[1] = {
    clusters: [
      {
        cluster: cluster.key,
        projects: [
          proposal("Course launch", 0, 1),
          proposal("Workshop series", 2, 3),
          proposal("Reading curriculum", 4, 5),
          proposal("Refund ticket", 0, 1),
        ],
        interests: [],
      },
    ],
  };
  const judged = collectClusterJudgments([cluster], document, references);
  const initial = rejectWhatTheModelGetsWrong(
    { projects: judged.projects },
    { interests: [] },
    threads,
    [],
    new Set(cluster.threadIds),
    USER,
  );
  const traceState = traceJudgeProposals(judged, [cluster], initial);
  const projectId = (name: string): string => `P${initial.projects.findIndex((row) => row.name === name) + 1}`;
  const reviewed = applyProjectReview(initial.projects, [], {
    projects: [
      {
        id: "new",
        name: "Learning program",
        aliases: [],
        goal: "Complete the learning program",
        status: "unknown",
        outcome: "",
        narrative: "",
        members: [projectId("Course launch"), projectId("Workshop series")],
        tracks: [],
        people: [],
        organizations: [],
        evidence: [],
      },
    ],
    demoted: [],
  });
  traceConceptReview(traceState, { projects: reviewed.outcomes, interests: [] });
  const final = rejectWhatTheModelGetsWrong(
    { projects: reviewed.proposals },
    { interests: [] },
    threads,
    [],
    new Set(cluster.threadIds),
    USER,
  );
  const trace = finishConceptTrace(traceState, final);
  const root = mkdtempSync(join(tmpdir(), "roze-trace-"));
  try {
    writeConceptFiles(final.projects, final.interests, {}, root, reviewed.log, trace);
    const stored = JSON.parse(readFileSync(join(root, "concepts.json"), "utf8")) as { trace: typeof trace };
    const rejected = stored.trace.find((row) => row.name === "Refund ticket")!;
    assert.equal(rejected.droppedAt, "initial_gates");
    assert.deepEqual(rejected.stages[0]?.counters, { project_loop_like_name: 1 });
    assert.equal(rejected.finalFile, undefined);

    const merged = stored.trace.find((row) => row.name === "Course launch")!;
    assert.deepEqual(
      merged.stages.find((stage) => stage.stage === "review"),
      { stage: "review", outcome: "merged", into: "Learning program" },
    );
    assert.equal(merged.finalFile, "projects/learning-program.md");
    assert.equal(merged.sourceClusterKind, "entity");

    const accepted = stored.trace.find((row) => row.name === "Reading curriculum")!;
    assert.equal(accepted.stages.find((stage) => stage.stage === "review")?.outcome, "kept");
    assert.equal(accepted.finalFile, "projects/reading-curriculum.md");

    const markdown = readFileSync(resolveMemoryFile(root, "concepts/TRACE.md"), "utf8");
    assert.match(markdown, /Refund ticket \(project\)[\s\S]*`project_loop_like_name`/u);
    assert.match(markdown, /Course launch \(project\)[\s\S]*merged into \*\*Learning program\*\*/u);
    const courseStart = markdown.indexOf("## Course launch");
    const course = markdown.slice(courseStart, markdown.indexOf("## ", courseStart + 3));
    assert.ok(course.indexOf("final_dedupe") < course.indexOf("review"));
    assert.ok(course.indexOf("review") < course.indexOf("initial_gates"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
