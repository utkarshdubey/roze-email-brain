// The gate boundary: where a proposed concept list becomes an accepted one, run on the judge's proposals
// and again on the review's answer. No model is called, so a stored concepts.json can be re-derived
// offline, and every rejection is counted by name to explain the gap between proposed and kept.
import { z } from "zod";
import { cleanText, compareText } from "../shared/text.js";
import {
  mergeRejections,
  reject,
  type ConceptGateResult,
  type EmailThread,
  type GateRuleOutcome,
  type GateRuleResult,
  type Interest,
  type Project,
  type ProposalGateOutcome,
  type RejectionCounts,
  type ThreadExtraction,
} from "../types.js";
import { buildEvidenceContext } from "./evidenceContext.js";
import { dropNearDuplicates, dropSubsumed, type DedupeOutcome } from "./dedupeConcepts.js";
import { gateInputInterestSchema, keepInterestsThatPass } from "./interestGates.js";
import { gateInputProjectSchema, keepProjectsThatPass } from "./projectGates.js";

const storedDocumentSchema = z
  .object({
    projects: z.array(gateInputProjectSchema.extend({ firstSeen: z.string(), lastActivity: z.string() }).strict()),
    interests: z.array(
      gateInputInterestSchema
        .extend({ firstSeen: z.string(), lastSeen: z.string(), engagement: z.enum(["direct", "passive"]) })
        .strict(),
    ),
    rejected: z.record(z.string(), z.number()),
    review: z.unknown().optional(),
    trace: z.unknown().optional(),
  })
  .strict();

interface ReadProposalResult<T> {
  proposals: T[];
  sourceIndexes: number[];
  outcomes: GateRuleOutcome[];
}

function proposalName(value: unknown, key: "projects" | "interests"): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return key === "projects" ? "(invalid project)" : "(invalid interest)";
  }
  const field = key === "projects" ? "name" : "topic";
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === "string" && cleanText(raw, 160)
    ? cleanText(raw, 160)
    : key === "projects"
      ? "(unnamed project)"
      : "(unnamed interest)";
}

/** A row that does not parse is counted and skipped; one bad row never fails the list. */
function readProposals<T>(
  document: unknown,
  key: "projects" | "interests",
  schema: z.ZodType<T>,
  counts: RejectionCounts,
): ReadProposalResult<T> {
  const envelope = z.record(z.string(), z.unknown()).safeParse(document);
  const values = envelope.success ? envelope.data[key] : undefined;
  if (!Array.isArray(values)) {
    reject(counts, `${key.slice(0, -1)}_document_schema`);
    return { proposals: [], sourceIndexes: [], outcomes: [] };
  }
  const proposals: T[] = [];
  const sourceIndexes: number[] = [];
  const outcomes: GateRuleOutcome[] = [];
  values.forEach((value, proposalIndex) => {
    // Judgments still carry their source cluster; that is not part of the record shape.
    const { cluster: _cluster, ...record } = (value ?? {}) as Record<string, unknown>;
    const row = schema.safeParse(record);
    if (row.success) {
      proposals.push(row.data);
      sourceIndexes.push(proposalIndex);
      return;
    }
    const counter = `${key.slice(0, -1)}_schema`;
    reject(counts, counter);
    outcomes.push({
      proposalIndex,
      name: proposalName(value, key),
      passed: false,
      counters: { [counter]: 1 },
    });
  });
  return { proposals, sourceIndexes, outcomes };
}
/** An alias that equals another project's name would make two concepts answer to one string. */
function removeAliasesThatCollideWithNames(
  projects: ConceptGateResult["projects"],
  counts: RejectionCounts,
): Map<Project, RejectionCounts> {
  const names = new Set(projects.map((row) => row.name.toLowerCase()));
  const outcomes = new Map<Project, RejectionCounts>();
  for (const project of projects) {
    const aliases = project.aliases.filter((alias) => !names.has(alias.toLowerCase()));
    const dropped = project.aliases.length - aliases.length;
    reject(counts, "project_alias_name_collision", dropped);
    if (dropped) {
      outcomes.set(project, { project_alias_name_collision: dropped });
    }
    project.aliases = aliases;
  }
  return outcomes;
}

interface CollapsedRows<T> {
  rows: T[];
  collapseByRow: Map<T, Extract<DedupeOutcome<T>, { outcome: "collapsed" }>>;
}

function collapseRows<T extends Project | Interest>(
  rows: readonly T[],
  counts: RejectionCounts,
  kind: "project" | "interest",
  nameOf: (row: T) => string,
): CollapsedRows<T> {
  const near = dropNearDuplicates(rows, counts, kind);
  const subsumed = dropSubsumed(near.kept, counts, kind, nameOf);
  const collapsed = [...near.outcomes, ...subsumed.outcomes].filter(
    (outcome): outcome is Extract<DedupeOutcome<T>, { outcome: "collapsed" }> => outcome.outcome === "collapsed",
  );
  return { rows: subsumed.kept, collapseByRow: new Map(collapsed.map((outcome) => [outcome.row, outcome])) };
}

function proposalOutcomes<T extends Project | Interest>(
  read: ReadProposalResult<unknown>,
  gated: GateRuleResult<T>,
  collapsed: CollapsedRows<T>,
  extraCounters: ReadonlyMap<T, RejectionCounts>,
  nameOf: (row: T) => string,
): ProposalGateOutcome[] {
  const sourceIndexByRow = new Map(
    gated.accepted.map((row, index) => [row, read.sourceIndexes[gated.acceptedProposalIndexes[index]!]!]),
  );
  const outcomeBySourceIndex = new Map<number, ProposalGateOutcome>(
    read.outcomes.map((outcome) => [outcome.proposalIndex, { ...outcome }]),
  );
  for (const outcome of gated.outcomes) {
    const sourceIndex = read.sourceIndexes[outcome.proposalIndex]!;
    outcomeBySourceIndex.set(sourceIndex, { ...outcome, proposalIndex: sourceIndex });
  }
  for (const [row, counters] of extraCounters) {
    const sourceIndex = sourceIndexByRow.get(row);
    const outcome = sourceIndex === undefined ? undefined : outcomeBySourceIndex.get(sourceIndex);
    if (outcome) {
      mergeRejections(outcome.counters, counters);
    }
  }
  const outputIndexByRow = new Map(collapsed.rows.map((row, index) => [row, index]));
  const survivorOf = (row: T): T => {
    const seen = new Set<T>();
    let survivor = row;
    while (collapsed.collapseByRow.has(survivor) && !seen.has(survivor)) {
      seen.add(survivor);
      survivor = collapsed.collapseByRow.get(survivor)!.into!;
    }
    return survivor;
  };
  for (const row of gated.accepted) {
    const sourceIndex = sourceIndexByRow.get(row)!;
    const outcome = outcomeBySourceIndex.get(sourceIndex)!;
    const collapse = collapsed.collapseByRow.get(row);
    const survivor = survivorOf(row);
    outcome.dedupe = collapse
      ? { outcome: "collapsed", counter: collapse.counter, into: nameOf(survivor) }
      : { outcome: "passed" };
    outcome.outputIndex = outputIndexByRow.get(survivor);
  }
  return [...outcomeBySourceIndex.values()].sort((left, right) => left.proposalIndex - right.proposalIndex);
}
/**
 * `scope` is what the model was actually shown; evidence outside it is invalid even when the thread
 * exists, which keeps the judge inside its clusters and the review inside its named context.
 */
export function rejectWhatTheModelGetsWrong(
  projectDocument: unknown,
  interestDocument: unknown,
  threads: readonly EmailThread[],
  extractions: readonly ThreadExtraction[] = [],
  scope?: ReadonlySet<string>,
  userEmail?: string,
): ConceptGateResult {
  const rejections: RejectionCounts = {};
  const context = buildEvidenceContext(threads, extractions, userEmail);
  const allowed =
    scope === undefined
      ? context.days
      : Object.fromEntries(Object.entries(context.days).filter(([id]) => scope.has(id)));
  const projectRead = readProposals(projectDocument, "projects", gateInputProjectSchema, rejections);
  const interestRead = readProposals(interestDocument, "interests", gateInputInterestSchema, rejections);
  const projectGates = keepProjectsThatPass(projectRead.proposals, context, allowed, rejections);
  const interestGates = keepInterestsThatPass(interestRead.proposals, context, allowed, rejections);
  const collapsedProjects = collapseRows(projectGates.accepted, rejections, "project", (row) => row.name);
  const collapsedInterests = collapseRows(interestGates.accepted, rejections, "interest", (row) => row.topic);
  const projects = collapsedProjects.rows;
  const interests = collapsedInterests.rows;
  const aliasCounters = removeAliasesThatCollideWithNames(projects, rejections);
  // Code-point ordering keeps generated files byte-stable across locales; localeCompare does not.
  projects.sort((a, b) => compareText(b.lastActivity, a.lastActivity) || compareText(b.name, a.name));
  interests.sort((a, b) => compareText(b.lastSeen, a.lastSeen) || compareText(b.topic, a.topic));
  const projectOutcomes = proposalOutcomes(
    projectRead,
    projectGates,
    collapsedProjects,
    aliasCounters,
    (row) => row.name,
  );
  const interestOutcomes = proposalOutcomes(
    interestRead,
    interestGates,
    collapsedInterests,
    new Map(),
    (row) => row.topic,
  );
  return {
    projects,
    interests,
    rejections: Object.fromEntries(
      Object.entries(rejections)
        .filter(([, count]) => count > 0)
        .sort(),
    ),
    outcomes: { projects: projectOutcomes, interests: interestOutcomes },
  };
}
export function validateStoredConceptDocument(
  document: unknown,
  threads: readonly EmailThread[],
  extractions: readonly ThreadExtraction[] = [],
  scope?: ReadonlySet<string>,
  userEmail?: string,
): ConceptGateResult {
  const stored = storedDocumentSchema.parse(document);
  return rejectWhatTheModelGetsWrong(
    { projects: stored.projects.map(({ firstSeen: _firstSeen, lastActivity: _lastActivity, ...row }) => row) },
    {
      interests: stored.interests.map(
        ({ firstSeen: _firstSeen, lastSeen: _lastSeen, engagement: _engagement, ...row }) => row,
      ),
    },
    threads,
    extractions,
    scope,
    userEmail,
  );
}
