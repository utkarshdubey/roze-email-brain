// Builds one inspectable lineage for every cluster-judge proposal, carrying it through both deterministic
// gate passes and the whole-list review without adding metadata to model inputs or accepted concepts.
import { cleanText } from "../shared/text.js";
import {
  type Citation,
  type ClusterJudgment,
  type ConceptGateResult,
  type ConceptReviewOutcome,
  type ConceptTrace,
  type ConceptTraceStage,
  type JudgeProposalTraceSource,
  type ProposalGateOutcome,
  type ThreadCluster,
} from "../types.js";

export const TRACE_FINAL_TARGET = Symbol("concept-trace-final-target");

export type TracedConcept = ConceptTrace & {
  [TRACE_FINAL_TARGET]?: { kind: "project" | "interest"; index: number };
};

interface TraceLineage {
  trace: TracedConcept;
  currentIndex?: number;
}

export interface ConceptTraceState {
  projects: TraceLineage[];
  interests: TraceLineage[];
}

const sortedCounters = (counters: Readonly<Record<string, number>>): Record<string, number> =>
  Object.fromEntries(Object.entries(counters).filter(([, count]) => count > 0).sort());

function gateStage(
  stage: "initial_gates" | "final_gates",
  outcome: ProposalGateOutcome,
): ConceptTraceStage {
  const counters = sortedCounters(outcome.counters);
  return {
    stage,
    outcome: outcome.passed ? "passed" : "rejected",
    ...(Object.keys(counters).length ? { counters } : {}),
  };
}

function dedupeStage(
  stage: "initial_dedupe" | "final_dedupe",
  outcome: ProposalGateOutcome,
): ConceptTraceStage {
  if (outcome.dedupe?.outcome === "collapsed") {
    return {
      stage,
      outcome: "collapsed",
      counters: { [outcome.dedupe.counter]: 1 },
      into: outcome.dedupe.into,
    };
  }
  return { stage, outcome: "passed" };
}

function citationsOf(rows: readonly Citation[]): Citation[] {
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const key = `${row.threadId}\0${row.day}`;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ threadId: row.threadId, day: row.day }];
  });
}

function initialLineage(
  proposal: JudgeProposalTraceSource,
  kind: "project" | "interest",
  outcomes: readonly ProposalGateOutcome[],
  clusterKinds: ReadonlyMap<string, ThreadCluster["kind"]>,
): TraceLineage {
  const name = cleanText(proposal.name, 160) || `(unnamed ${kind})`;
  if (proposal.rejectedBy) {
    return {
      trace: {
        name,
        kind,
        sourceClusterKey: proposal.cluster,
        sourceClusterKind: clusterKinds.get(proposal.cluster) ?? "unknown",
        citations: citationsOf(proposal.citations),
        stages: [{ stage: "judge", outcome: "rejected", counters: { [proposal.rejectedBy]: 1 } }],
        droppedAt: "judge",
      },
    };
  }
  const outcome = outcomes[proposal.gateInputIndex!];
  if (!outcome) {
    throw new Error(`Initial gates omitted judge proposal ${proposal.gateInputIndex}`);
  }
  const stages = [gateStage("initial_gates", outcome)];
  if (outcome.passed) {
    stages.push(dedupeStage("initial_dedupe", outcome));
  }
  return {
    trace: {
      name,
      kind,
      sourceClusterKey: proposal.cluster,
      sourceClusterKind: clusterKinds.get(proposal.cluster) ?? "unknown",
      citations: citationsOf(proposal.citations),
      stages,
      ...(!outcome.passed ? { droppedAt: "initial_gates" as const } : {}),
    },
    currentIndex: outcome.passed ? outcome.outputIndex : undefined,
  };
}

/** Starts trace state at the judge boundary; proposal indexes are stable within each kind. */
export function traceJudgeProposals(
  judgment: ClusterJudgment,
  clusters: readonly ThreadCluster[],
  gated: ConceptGateResult,
): ConceptTraceState {
  const clusterKinds = new Map(clusters.map((cluster) => [cluster.key, cluster.kind]));
  return {
    projects: judgment.proposals.projects.map((proposal) =>
      initialLineage(proposal, "project", gated.outcomes.projects, clusterKinds),
    ),
    interests: judgment.proposals.interests.map((proposal) =>
      initialLineage(proposal, "interest", gated.outcomes.interests, clusterKinds),
    ),
  };
}

function reviewStage(outcome: ConceptReviewOutcome): ConceptTraceStage {
  return {
    stage: "review",
    outcome: outcome.verdict,
    ...(outcome.into ? { into: outcome.into } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  };
}

function applyReviewOutcomes(lineages: TraceLineage[], outcomes: readonly ConceptReviewOutcome[]): void {
  const byInput = new Map(outcomes.map((outcome) => [outcome.inputIndex, outcome]));
  for (const lineage of lineages) {
    if (lineage.currentIndex === undefined) {
      continue;
    }
    const outcome = byInput.get(lineage.currentIndex);
    if (!outcome) {
      throw new Error(`Review omitted trace input ${lineage.currentIndex}`);
    }
    lineage.trace.stages.push(reviewStage(outcome));
    if (outcome.verdict === "demoted") {
      lineage.trace.droppedAt = "review";
      lineage.currentIndex = undefined;
    } else {
      lineage.currentIndex = outcome.outputIndex;
    }
  }
}

/** Applies the whole-list review disposition to every surviving original proposal. */
export function traceConceptReview(
  state: ConceptTraceState,
  outcomes: { projects: readonly ConceptReviewOutcome[]; interests: readonly ConceptReviewOutcome[] },
): void {
  applyReviewOutcomes(state.projects, outcomes.projects);
  applyReviewOutcomes(state.interests, outcomes.interests);
}

function applyFinalGateOutcomes(
  lineages: TraceLineage[],
  outcomes: readonly ProposalGateOutcome[],
  kind: "project" | "interest",
): void {
  const byInput = new Map(outcomes.map((outcome) => [outcome.proposalIndex, outcome]));
  for (const lineage of lineages) {
    if (lineage.currentIndex === undefined) {
      continue;
    }
    const outcome = byInput.get(lineage.currentIndex);
    if (!outcome) {
      throw new Error(`Final gates omitted trace input ${lineage.currentIndex}`);
    }
    lineage.trace.stages.push(gateStage("final_gates", outcome));
    if (!outcome.passed) {
      lineage.trace.droppedAt = "final_gates";
      lineage.currentIndex = undefined;
      continue;
    }
    lineage.trace.stages.push(dedupeStage("final_dedupe", outcome));
    lineage.currentIndex = outcome.outputIndex;
    if (outcome.outputIndex !== undefined) {
      lineage.trace[TRACE_FINAL_TARGET] = { kind, index: outcome.outputIndex };
    }
  }
}

/** Adds the second gate pass and attaches a non-serialized pointer to the final rendered concept file. */
export function finishConceptTrace(state: ConceptTraceState, gated: ConceptGateResult): ConceptTrace[] {
  applyFinalGateOutcomes(state.projects, gated.outcomes.projects, "project");
  applyFinalGateOutcomes(state.interests, gated.outcomes.interests, "interest");
  return [...state.projects, ...state.interests].map((lineage) => lineage.trace);
}
