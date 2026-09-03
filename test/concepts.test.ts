import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { rejectWhatTheModelGetsWrong } from "../src/concepts/applyGates.js";
import { buildClusters } from "../src/concepts/buildClusters.js";
import { makeThreadCards } from "../src/concepts/buildConcepts.js";
import { buildJudgeRequest, collectClusterJudgments } from "../src/concepts/judgeClusters.js";
import { buildTagRequest } from "../src/concepts/tagLifeDomains.js";
import type {
  EmailThread,
  InterestEvidenceRole,
  ProjectEvidenceRole,
  ProposedInterest,
  ProposedProject,
  ThreadExtraction,
} from "../src/types.js";
import { extraction, message, thread, USER } from "./helpers.js";

const A = thread("aaaaaaaaaaaa0001", ["2026-01-01", "2026-01-02"]);
const B: EmailThread = {
  id: "bbbbbbbbbbbb0002",
  messages: [
    message("bbbbbbbbbbbb0002", "2026-02-01"),
    message("bbbbbbbbbbbb0002", "2026-02-02", USER),
    message("bbbbbbbbbbbb0002", "2026-02-03", USER),
    message("bbbbbbbbbbbb0002", "2026-09-01", "news@taskade.com", "Marketing", ["CATEGORY_PROMOTIONS"]),
  ],
};
const C = thread("cccccccccccc0003", ["2026-01-05"]);
const D = thread("dddddddddddd0004", ["2026-01-15", "2026-03-01"]);
const E = thread("eeeeeeeeeeee0005", ["2026-04-01"]);
const F = thread("ffffffffffff0006", ["2026-01-01"]);
const O1 = thread("1111111111110007", ["2019-01-01"]);
const O2 = thread("2222222222220008", ["2019-03-01"]);
const THREADS = [A, B, C, D, E, F, O1, O2];
const org = (name: string) => ({ name, kind: "organization" as const, email: "", org: "", role: "company" });
const person = (name: string, email: string, company: string) => ({
  name,
  kind: "person" as const,
  email,
  org: company,
  role: "lead",
});
const EXTRACTIONS: ThreadExtraction[] = [
  extraction(A, {
    summary: "Rox FDE process",
    mentions: [org("Rox"), person("Erin Wilson", "erin@rox.com", "Rox"), person("Mailbox Owner", USER, "")],
  }),
  extraction(B, { summary: "Rox decision", mentions: [org("Rox"), person("Erin W.", "erin@rox.com", "Rox")] }),
  extraction(C),
  extraction(D, { mentions: [org("Known")] }),
  extraction(E),
  extraction(F),
  extraction(O1),
  extraction(O2),
];
const pe = (threadId: string, day: string, role: ProjectEvidenceRole) => ({ threadId, day, role, reason: "Entailed." });
const ie = (threadId: string, day: string, role: InterestEvidenceRole) => ({
  threadId,
  day,
  role,
  reason: "Entailed.",
});
const validProjectEvidence = () => [pe(A.id, "2026-01-01", "goal"), pe(B.id, "2026-02-01", "outcome")];
const validInterestEvidence = () => [ie(A.id, "2026-01-02", "active_signal"), ie(B.id, "2026-02-02", "reaffirmed")];
function project(
  name: string,
  evidence = validProjectEvidence(),
  changes: Partial<ProposedProject> = {},
): ProposedProject {
  return {
    name,
    aliases: [],
    goal: "Land the role",
    status: "unknown",
    outcome: "",
    people: [],
    organizations: [],
    evidence,
    ...changes,
  };
}
function interest(
  topic: string,
  evidence = validInterestEvidence(),
  changes: Partial<ProposedInterest> = {},
): ProposedInterest {
  return { topic, kind: "subject", currentState: "unclear", summary: "Recurring behavior.", evidence, ...changes };
}
const gate = (projects: unknown = [], interests: unknown = [], threads = THREADS, extractions = EXTRACTIONS) =>
  rejectWhatTheModelGetsWrong({ projects }, { interests }, threads, extractions, undefined, USER);
function valueAt(source: unknown, ...keys: string[]): unknown {
  let value = source;
  for (const key of keys) {
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

test("cards stay body-free; clusters recur; model schemas bind exact ids, dates, and strict objects", () => {
  const cards = makeThreadCards(EXTRACTIONS, THREADS, USER);
  assert.doesNotMatch(JSON.stringify(cards), /RAW BODY/u);
  const rox = buildClusters(cards, {}).find((cluster) => cluster.anchor === "Rox")!;
  assert.deepEqual(new Set(rox.threadIds), new Set([A.id, B.id]));
  const tagJson = z.toJSONSchema(buildTagRequest(cards.slice(0, 2), USER).schema, { target: "draft-07", io: "input" });
  assert.deepEqual(
    valueAt(tagJson, "properties", "threads", "items", "properties", "id", "enum"),
    cards.slice(0, 2).map((card) => card.threadId),
  );
  assert.equal(tagJson.additionalProperties, false);
  const { request } = buildJudgeRequest([rox], cards, {}, USER, "2026-09-02");
  const json = z.toJSONSchema(request.schema, { target: "draft-07", io: "input" });
  const evidence = valueAt(
    json,
    "properties",
    "clusters",
    "items",
    "properties",
    "projects",
    "items",
    "properties",
    "evidence",
    "items",
    "properties",
  );
  assert.ok(evidence && typeof evidence === "object" && !Array.isArray(evidence));
  assert.deepEqual(Object.keys(evidence).sort(), ["reason", "role", "source_ref"]);
  const references = valueAt(evidence, "source_ref", "enum");
  assert.ok(Array.isArray(references) && references.includes(`${B.id}::2026-02-01`));
  assert.deepEqual(json.required, ["clusters"]);
});

test("cluster locality discards borrowed evidence and unknown clusters", () => {
  const cluster = { key: "rox", anchor: "Rox", aliases: [], kind: "entity" as const, threadIds: [A.id, B.id] };
  const raw = (name: string, second: string) => ({
    name,
    aliases: [],
    goal: "Land role",
    status: "unknown" as const,
    outcome: "",
    people: [],
    organizations: [],
    evidence: [
      { source_ref: `${A.id}::2026-01-01`, reason: "r", role: "goal" as const },
      { source_ref: `${second}::2026-02-01`, reason: "r", role: "outcome" as const },
    ],
  });
  const document: Parameters<typeof collectClusterJudgments>[1] = {
    clusters: [
      { cluster: "rox", projects: [raw("inside", B.id), raw("leak", D.id)], interests: [] },
      { cluster: "ghost", projects: [raw("ghost", B.id)], interests: [] },
    ],
  };
  const references = {
    [`${A.id}::2026-01-01`]: { threadId: A.id, day: "2026-01-01" },
    [`${B.id}::2026-02-01`]: { threadId: B.id, day: "2026-02-01" },
    [`${D.id}::2026-02-01`]: { threadId: D.id, day: "2026-02-01" },
  };
  const result = collectClusterJudgments([cluster], document, references);
  assert.deepEqual(
    result.projects.map((row) => row.name),
    ["inside"],
  );
  assert.deepEqual(result.rejections, { project_outside_cluster: 1, cluster_unknown: 1 });
});

test("every project gate remains observable", () => {
  const seen = new Set<string>();
  const observe = (projects: unknown, threads = THREADS, extractions = EXTRACTIONS) =>
    Object.keys(gate(projects, [], threads, extractions).rejections).forEach((name) => seen.add(name));
  Object.keys(rejectWhatTheModelGetsWrong(null, { interests: [] }, THREADS).rejections).forEach((name) =>
    seen.add(name),
  );
  observe([{}]);
  observe([
    project("Bad date", [pe(A.id, "2026-01-01", "goal"), pe(B.id, "2099-01-01", "outcome")]),
    project("No goal", [pe(A.id, "2026-01-01", "progress"), pe(B.id, "2026-02-01", "outcome")]),
    project("Refund case 123", validProjectEvidence()),
    project("Too quick", [pe(A.id, "2026-01-01", "goal"), pe(C.id, "2026-01-05", "progress")]),
    project("Completion", [pe(A.id, "2026-01-01", "goal"), pe(B.id, "2026-02-01", "current_state")], {
      status: "completed",
      outcome: "Done",
    }),
    project("Ungrounded active", [pe(A.id, "2026-01-01", "goal"), pe(B.id, "2026-02-01", "dependency")], {
      status: "active",
    }),
    project("Automated state", [...validProjectEvidence(), pe(B.id, "2026-09-01", "current_state")]),
    project("Parties", validProjectEvidence(), {
      aliases: ["Rox FDE process", "Phantom"],
      people: ["Mailbox Owner", "Erin Wilson", "Erin W.", "Ghost"],
      organizations: ["Rox", "Ghost Inc"],
    }),
    project("Duplicate"),
    project("Duplicate"),
    project("", validProjectEvidence()),
  ]);
  observe([
    project("Old", [pe(O1.id, "2019-01-01", "goal"), pe(O2.id, "2019-03-01", "current_state")], { status: "active" }),
  ]);
  observe([
    project("Rox interview", validProjectEvidence(), { aliases: ["Rox FDE process"] }),
    project("Rox FDE process", [pe(D.id, "2026-01-15", "goal"), pe(E.id, "2026-04-01", "outcome")]),
  ]);
  const required = [
    "project_document_schema",
    "project_schema",
    "project_invalid_evidence",
    "project_insufficient_threads",
    "project_ungrounded_goal",
    "project_loop_like_name",
    "project_too_brief",
    "project_ungrounded_outcome",
    "project_completed_without_outcome",
    "project_ungrounded_status",
    "project_automated_state_evidence",
    "project_stale_active_state",
    "project_duplicate_or_empty",
    "project_self_participant",
    "project_duplicate_participant",
    "project_ungrounded_participant",
    "project_ungrounded_alias",
    "project_alias_name_collision",
  ];
  assert.deepEqual(
    required.filter((name) => !seen.has(name)),
    [],
  );
});

test("every interest gate remains observable", () => {
  const seen = new Set<string>();
  const observe = (interests: unknown) => Object.keys(gate([], interests).rejections).forEach((name) => seen.add(name));
  Object.keys(rejectWhatTheModelGetsWrong({ projects: [] }, null, THREADS).rejections).forEach((name) =>
    seen.add(name),
  );
  observe([{}]);
  observe([
    interest("Invalid", [...validInterestEvidence(), ie(B.id, "2099-01-01", "current_positive")]),
    interest("One thread", [ie(A.id, "2026-01-01", "active_signal"), ie(A.id, "2026-01-02", "reaffirmed")]),
    interest("One behavior", [ie(A.id, "2026-01-01", "active_signal"), ie(B.id, "2026-02-01", "passive_signal")]),
    interest("Same day", [ie(A.id, "2026-01-01", "active_signal"), ie(F.id, "2026-01-01", "reaffirmed")]),
    interest("Automated", [...validInterestEvidence(), ie(B.id, "2026-09-01", "current_positive")], {
      currentState: "active",
    }),
    interest("Former", validInterestEvidence(), { currentState: "former" }),
    interest("Later negative", [...validInterestEvidence(), ie(B.id, "2026-02-03", "current_negative")], {
      currentState: "active",
    }),
    interest("Later positive", [ie(A.id, "2026-01-01", "negative_signal"), ...validInterestEvidence()], {
      currentState: "former",
    }),
    interest("Erin Wilson"),
    interest("Duplicate"),
    interest("Duplicate"),
    interest("", validInterestEvidence()),
    interest(
      "Child scope",
      [
        ie(A.id, "2026-01-02", "active_signal"),
        ie(D.id, "2026-01-15", "reaffirmed"),
        ie(B.id, "2026-02-03", "current_negative"),
      ],
      { currentState: "former" },
    ),
    interest("Old hobby", [ie(O1.id, "2019-01-01", "active_signal"), ie(O2.id, "2019-03-01", "reaffirmed")], {
      currentState: "active",
    }),
  ]);
  const required = [
    "interest_document_schema",
    "interest_schema",
    "interest_invalid_evidence",
    "interest_insufficient_threads",
    "interest_insufficient_behavioral_threads",
    "interest_insufficient_distinct_episode_dates",
    "interest_automated_state_evidence",
    "interest_duplicate_or_empty",
    "interest_is_person",
    "interest_ungrounded_former_state",
    "interest_state_corrected_by_later_negative",
    "interest_state_corrected_by_later_positive",
    "interest_state_corrected_by_child_scope",
    "interest_stale_active_state",
  ];
  assert.deepEqual(
    required.filter((name) => !seen.has(name)),
    [],
  );
});

test("near-duplicate and subsumed-name collapse retains the better-supported concepts", () => {
  const projects = gate([
    project("Cloud move"),
    project("AWS migration", [...validProjectEvidence(), pe(A.id, "2026-01-02", "progress")]),
    project("Rox FDE interview process", [
      pe(D.id, "2026-01-15", "goal"),
      pe(D.id, "2026-03-01", "progress"),
      pe(E.id, "2026-04-01", "outcome"),
    ]),
    project("Rox interview process", [pe(O1.id, "2019-01-01", "goal"), pe(O2.id, "2019-03-01", "outcome")]),
  ]).rejections;
  assert.equal(projects.project_near_duplicate, 1);
  assert.equal(projects.project_subsumed_name, 1);
  const interests = gate(
    [],
    [
      interest("Rox recruiting"),
      interest("Rox recruiting notices", validInterestEvidence()),
      interest("AI coding tools", [
        ie(D.id, "2026-01-15", "active_signal"),
        ie(D.id, "2026-03-01", "reaffirmed"),
        ie(E.id, "2026-04-01", "reaffirmed"),
      ]),
      interest("coding tools", [ie(O1.id, "2019-01-01", "active_signal"), ie(O2.id, "2019-03-01", "reaffirmed")]),
    ],
  ).rejections;
  assert.equal(interests.interest_near_duplicate, 1);
  assert.equal(interests.interest_subsumed_topic, 1);
});

test("gates accept judgments that still carry their source cluster", () => {
  const result = gate(
    [{ ...project("Rox FDE interview"), cluster: "entity-rox" }],
    [{ ...interest("recruiting"), cluster: "domain-job-search" }],
  );
  assert.equal(result.projects.length, 1);
  assert.equal(result.interests.length, 1);
  assert.equal(result.rejections["project_schema"], undefined);
  assert.equal(result.rejections["interest_schema"], undefined);
});
