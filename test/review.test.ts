import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { rejectWhatTheModelGetsWrong } from "../src/concepts/applyGates.js";
import { buildClusters } from "../src/concepts/buildClusters.js";
import { findRelatedThreads, indexThreadsForNameSearch } from "../src/concepts/buildConcepts.js";
import { buildClusterJudgeBatches } from "../src/concepts/judgeClusters.js";
import { recurringMerchants } from "../src/memory/recurringMerchants.js";
import { applyInterestReview, applyProjectReview } from "../src/concepts/reviewConcepts.js";
import { buildInterestReviewRequest, buildProjectReviewRequest } from "../src/concepts/reviewRequests.js";
import { planPhases } from "../src/generation/phases.js";
import type { EmailThread, Interest, OpenLoopRow, Project, ThreadCard, ThreadCluster } from "../src/types.js";
import { extraction, message, thread, USER } from "./helpers.js";

const A = thread("aaaaaaaaaaaa0001", ["2026-01-01", "2026-01-02"]);
const B = thread("bbbbbbbbbbbb0002", ["2026-02-01", "2026-02-02"]);
const C = thread("cccccccccccc0003", ["2026-03-01", "2026-03-15"]);
const L = thread("dddddddddddd0004", ["2026-04-01"]);
const receipt = (id: string, day: string, merchant: string, body: string): EmailThread => ({
  id,
  messages: [
    {
      ...message(id, day, "receipts@stripe.example", `Your receipt from ${merchant}`, ["CATEGORY_UPDATES"]),
      fromName: "Stripe",
      body,
    },
  ],
});
const R1 = receipt("eeeeeeeeeeee0005", "2025-10-01", "Toolco", "Amount paid $15.00");
const R2 = receipt("eeeeeeeeeeee0006", "2025-11-01", "Toolco", "Amount paid $15.00");
const R3 = receipt("eeeeeeeeeeee0007", "2025-12-01", "Once", "Amount paid $5.00");
const THREADS = [A, B, C, L];
const EXTRACTIONS = [
  extraction(A, {
    summary: "Acme interview scheduling",
    mentions: [{ name: "Acme", kind: "organization", email: "", org: "", role: "" }],
  }),
  extraction(B, {
    summary: "Acme decision",
    mentions: [{ name: "Acme", kind: "organization", email: "", org: "", role: "" }],
  }),
  extraction(C, {
    summary: "Globex application",
    mentions: [{ name: "Globex", kind: "organization", email: "", org: "", role: "" }],
  }),
  extraction(L, {
    summary: "Initech recruiter outreach",
    mentions: [{ name: "Initech", kind: "organization", email: "", org: "", role: "" }],
  }),
];
const ref = (id: string, day: string): string => `${id}::${day}`;
function project(name: string, evidence: Project["evidence"], organizations: string[] = []): Project {
  return {
    name,
    aliases: [],
    goal: `Land the role at ${name}`,
    status: "unknown",
    outcome: "",
    people: [],
    organizations,
    evidence,
    firstSeen: evidence[0]!.day,
    lastActivity: evidence.at(-1)!.day,
    narrative: "",
    tracks: [],
    related: [],
  };
}
function interest(topic: string, evidence: Interest["evidence"]): Interest {
  return {
    topic,
    kind: "subject",
    currentState: "unclear",
    summary: "Recurring.",
    evidence,
    firstSeen: evidence[0]!.day,
    lastSeen: evidence.at(-1)!.day,
    engagement: "direct",
    narrative: "",
    related: [],
  };
}
const acme = project(
  "Acme interview",
  [
    { threadId: A.id, day: "2026-01-01", role: "goal", reason: "Invited." },
    { threadId: B.id, day: "2026-02-01", role: "outcome", reason: "Rejected." },
  ],
  ["Acme"],
);
const globex = project(
  "Globex application",
  [
    { threadId: C.id, day: "2026-03-01", role: "goal", reason: "Applied." },
    { threadId: C.id, day: "2026-03-15", role: "current_state", reason: "Waiting." },
  ],
  ["Globex"],
);
const loop: OpenLoopRow = {
  entity: "Initech",
  path: "organizations/initech.md",
  text: "Recruiter asked for a call.",
  threadId: L.id,
  day: "2026-04-01",
};
const gate = (projects: unknown, interests: unknown, threads: EmailThread[] = THREADS) =>
  rejectWhatTheModelGetsWrong({ projects }, { interests }, threads, EXTRACTIONS, undefined, USER);
const card = (threadId: string, day: string, summary: string): ThreadCard => ({
  threadId,
  days: [day],
  userParticipated: true,
  userStarted: true,
  subjects: ["s"],
  summary,
  state: "none",
  stateNote: "",
  mentions: [],
  items: [],
  firstDay: day,
  lastDay: day,
  engaged: true,
  substantive: true,
});

test("the review request binds source references to member evidence and named context only", () => {
  const request = buildProjectReviewRequest([acme, globex], [loop], USER, "2026-09-02");
  const json = z.toJSONSchema(request.schema, { target: "draft-07", io: "input" }) as unknown as {
    properties: { projects: { items: { properties: Record<string, unknown> } } };
  };
  const enumOf = (path: unknown): string[] =>
    (path as { items: { properties: { source_ref: { enum: string[] } } } }).items.properties.source_ref.enum;
  assert.deepEqual(enumOf(json.properties.projects.items.properties.evidence).sort(), [
    ref(A.id, "2026-01-01"),
    ref(B.id, "2026-02-01"),
    ref(C.id, "2026-03-01"),
    ref(C.id, "2026-03-15"),
    ref(L.id, "2026-04-01"),
  ]);
  assert.match(request.user, /^PROJECTS/u);
  assert.match(request.user, /P2 \| Globex application/u);
  assert.match(request.user, /L1 \| 2026-04-01 \| Initech/u);
  assert.doesNotMatch(request.user, /RAW BODY/u);
});

test("review verdicts merge, fold loops into tracks, demote with a reason, keep the unmentioned, and drop borrowed evidence", () => {
  const document = {
    projects: [
      {
        id: "new",
        name: "2026 job search",
        aliases: [],
        goal: "Find a role",
        status: "active" as const,
        outcome: "",
        narrative: "Acme rejected me in February 2026; Initech reached out in April.",
        members: ["P1"],
        tracks: [
          { name: "Acme", status: "cancelled" as const, outcome: "rejected", source_ref: ref(B.id, "2026-02-01") },
          { name: "Initech", status: "active" as const, outcome: "", source_ref: ref(L.id, "2026-04-01") },
          { name: "Globex", status: "active" as const, outcome: "", source_ref: ref(C.id, "2026-03-01") },
        ],
        people: [],
        organizations: ["Acme", "Initech"],
        evidence: [
          { source_ref: ref(A.id, "2026-01-01"), role: "goal" as const, reason: "Acme invited me." },
          { source_ref: ref(L.id, "2026-04-01"), role: "progress" as const, reason: "Initech reached out." },
          {
            source_ref: ref(C.id, "2026-03-15"),
            role: "current_state" as const,
            reason: "Borrowed from an unlisted member.",
          },
        ],
      },
    ],
    demoted: [
      { id: "P2", reason: "single_incident_or_ticket" as const, note: "one form" },
      { id: "P2", reason: "recurring_service" as const, note: "again" },
    ],
  };
  const applied = applyProjectReview([acme, globex], [loop], document);
  assert.deepEqual(
    applied.proposals.map((row) => row.name),
    ["2026 job search"],
  );
  const umbrella = applied.proposals[0]!;
  assert.deepEqual(
    umbrella.evidence.map((row) => ref(row.threadId, row.day)),
    [ref(A.id, "2026-01-01"), ref(L.id, "2026-04-01"), ref(B.id, "2026-02-01")],
    "chosen rows first, then the member's remaining rows",
  );
  assert.deepEqual(
    (umbrella as Project).tracks.map((track) => track.name),
    ["Acme", "Initech"],
    "a track citing an unlisted member is dropped",
  );
  assert.deepEqual(applied.log.merged, [{ into: "2026 job search", members: ["Acme interview"] }]);
  assert.deepEqual(applied.log.demoted, [{ name: "Globex application", reason: "single_incident_or_ticket" }]);
  assert.deepEqual(applied.log.rejections, {
    project_demoted_single_incident_or_ticket: 1,
    review_conflicting_verdict: 1,
    review_evidence_outside_members: 1,
    project_track_outside_members: 1,
  });
  const longIncident = applyProjectReview([acme, globex], [loop], {
    projects: [],
    demoted: [{ id: "P1", reason: "single_incident_or_ticket", note: "spans a month" }],
  });
  assert.deepEqual(
    longIncident.log.rejections,
    { review_demotion_unsupported: 1 },
    "a month-long effort is not a single incident, whatever the model says",
  );
  assert.equal(longIncident.proposals.length, 2);
  const untouched = applyProjectReview([acme, globex], [loop], { projects: [], demoted: [] });
  assert.deepEqual(
    untouched.proposals.map((row) => row.name),
    ["Acme interview", "Globex application"],
  );
  const gated = gate(applied.proposals, []);
  assert.equal(gated.projects[0]?.tracks.length, 2);
  assert.match(gated.projects[0]!.narrative, /Initech/u);
});

test("recurring merchants need receipts on two days in two threads, and the interest review can cite them", () => {
  const merchants = recurringMerchants([R1, R2, R3]);
  assert.deepEqual(
    merchants.map((row) => [row.merchant, row.count, row.months]),
    [["Toolco", 2, 2]],
  );
  const tools = interest("Toolco", [
    { threadId: A.id, day: "2026-01-02", role: "active_signal", reason: "Used it." },
    { threadId: B.id, day: "2026-02-02", role: "reaffirmed", reason: "Again." },
  ]);
  const request = buildInterestReviewRequest([tools], merchants, USER, "2026-09-02");
  assert.match(request.user, /M1 \| Toolco \| receipt \| 2 \| 2025-10-01\.\.2025-11-01/u);
  const applied = applyInterestReview([tools], merchants, {
    interests: [
      {
        id: "I1",
        topic: "paid developer tools",
        kind: "tool",
        current_state: "unclear",
        summary: "Pays for tools.",
        narrative: "Paid Toolco in late 2025 after using it in early 2026.",
        members: [],
        merchants: ["M1"],
        evidence: [
          { source_ref: ref(R1.id, "2025-10-01"), role: "passive_signal", reason: "First receipt." },
          { source_ref: ref(R2.id, "2025-11-01"), role: "reaffirmed", reason: "Second receipt." },
        ],
      },
    ],
    dropped: [],
  });
  assert.equal(applied.proposals.length, 1);
  assert.deepEqual(applied.log.merged, [{ into: "paid developer tools", members: ["Toolco", "receipts: Toolco"] }]);
  const gated = gate([], applied.proposals, [...THREADS, R1, R2, R3]);
  assert.equal(gated.interests[0]?.topic, "paid developer tools");
  assert.equal(gated.interests[0]?.evidence.length, 4);
  assert.equal(gated.interests[0]?.engagement, "direct", "the user wrote in two of the cited threads");
});

test("gates drop narratives naming years outside the evidence, invalid tracks, and unverifiable related rows", () => {
  const { firstSeen: _first, lastActivity: _last, ...proposal } = acme;
  const withExtras = {
    ...proposal,
    narrative: "It started in 2024 and ended in 2026.",
    tracks: [{ name: "Ghost", status: "active" as const, outcome: "", threadId: A.id, day: "2099-01-01" }],
    related: [
      { threadId: C.id, day: "2026-03-01", subject: "Globex" },
      { threadId: C.id, day: "2027-01-01", subject: "Bad day" },
      { threadId: A.id, day: "2026-01-02", subject: "Already cited" },
    ],
  };
  const gated = gate([withExtras], []);
  assert.equal(gated.projects[0]?.narrative, "");
  assert.deepEqual(gated.projects[0]?.tracks, []);
  assert.deepEqual(gated.projects[0]?.related, [{ threadId: C.id, day: "2026-03-01", subject: "Globex" }]);
  assert.deepEqual(gated.rejections, {
    project_narrative_dates_unsupported: 1,
    project_track_invalid: 1,
    project_related_invalid: 2,
  });
});

test("related threads match whole names across extracted and body-only threads and skip cited ones", () => {
  const body: EmailThread = {
    id: "ffffffffffff0008",
    messages: [
      {
        ...message("ffffffffffff0008", "2026-05-01", "news@acme.example", "Acme newsletter"),
        body: "Acme news",
        snippet: "Acme news",
      },
    ],
  };
  const index = indexThreadsForNameSearch([...THREADS, body], EXTRACTIONS, USER);
  const related = findRelatedThreads(index, ["Acme", "university"], new Set([A.id]));
  assert.deepEqual(
    related.map((row) => row.threadId),
    [body.id, B.id],
  );
  assert.deepEqual(findRelatedThreads(index, ["Acm"], new Set()), [], "names under four characters never match");
});

test("judge batches are hash-bucketed so a changed cluster leaves the other batches byte-identical", () => {
  const cards = Array.from({ length: 60 }, (_, index) =>
    card(`t${String(index).padStart(15, "0")}`, "2026-01-01", "x".repeat(2_000)),
  );
  const cluster = (index: number, size: number): ThreadCluster => ({
    key: `entity-${index}`,
    anchor: `Org ${index}`,
    aliases: [],
    kind: "entity",
    threadIds: cards.slice(0, size).map((row) => row.threadId),
  });
  const clusters = Array.from({ length: 40 }, (_, index) => cluster(index, 3));
  const before = buildClusterJudgeBatches(clusters, cards, {});
  const after = buildClusterJudgeBatches(
    clusters.map((row, index) => (index === 7 ? cluster(7, 25) : row)),
    cards,
    {},
  );
  const key = (batch: ThreadCluster[]): string => batch.map((row) => `${row.key}:${row.threadIds.length}`).join(",");
  const unchanged = before.filter((batch) => !batch.some((row) => row.key === "entity-7")).map(key);
  assert.ok(unchanged.length >= before.length - 2);
  for (const batch of unchanged) assert.ok(after.map(key).includes(batch), `batch ${batch} should survive unchanged`);
});

test("bodies still publish before concepts so receipts can feed the interest review", () => {
  assert.deepEqual(
    planPhases({ noPromote: false, noSynthesize: false, noSkim: false, publishOnce: false, recentMonths: 24 }),
    [
      "full-read",
      "fast-inbox",
      "complete-inbox",
      "body-evidence",
      "concepts",
    ],
  );
  assert.deepEqual(
    planPhases({ noPromote: false, noSynthesize: false, noSkim: true, publishOnce: false, recentMonths: 24 }),
    [
      "full-read",
      "concepts",
    ],
  );
});

test("a domain with more cards than one request holds is judged per year, so recent efforts survive the cap", () => {
  const cards = Array.from({ length: 50 }, (_, index) =>
    card(`d${String(index).padStart(15, "0")}`, `${index < 45 ? 2021 : 2026}-06-01`, "x"),
  );
  const tags = Object.fromEntries(
    cards.map((row) => [row.threadId, { domains: ["education & university"], topic: "" }]),
  );
  const clusters = buildClusters(cards, tags).filter((cluster) => cluster.kind === "domain");
  assert.deepEqual(
    clusters.map((cluster) => [cluster.anchor, cluster.threadIds.length]),
    [
      ["education & university 2021", 40],
      ["education & university 2026", 5],
    ],
  );
  const small = buildClusters(cards.slice(0, 10), tags).filter((cluster) => cluster.kind === "domain");
  assert.deepEqual(
    small.map((cluster) => cluster.anchor),
    ["education & university"],
  );
});
