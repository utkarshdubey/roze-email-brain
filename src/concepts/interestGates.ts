// The deterministic rules a proposed INTEREST must pass, the mirror of `projectGates.ts`. An interest is
// a recurrence rather than an effort with an endpoint, so the rules test for repetition instead of a goal.
// "Active" and "former" are claims about now, so each is re-derived from the mail, and every correction
// increments a named counter rather than silently rewriting the model's answer.
import { z } from "zod";
import { countDaysBetween } from "../shared/dates.js";
import { cleanText, normalizeNameKey } from "../shared/text.js";
import {
  INTEREST_EVIDENCE_ROLES,
  INTEREST_KINDS,
  INTEREST_STATES,
  mergeRejections,
  reject,
  type EvidenceRow,
  type GateRuleResult,
  type Interest,
  type InterestEvidenceRole,
  type RejectionCounts,
} from "../types.js";
import {
  dayCanCarryState,
  dayHasHumanMessage,
  firstMessageDay,
  keepGroundedNarrative,
  keepValidEvidence,
  keepValidRelated,
  MAX_RELATED_ROWS,
  observedParties,
  relatedThreadSchema,
  type EvidenceContext,
} from "./evidenceContext.js";

const interestEvidenceSchema = z
  .object({ threadId: z.string(), day: z.string(), reason: z.string(), role: z.enum(INTEREST_EVIDENCE_ROLES) })
  .strict();
export const gateInputInterestSchema = z
  .object({
    topic: z.string(),
    kind: z.enum(INTEREST_KINDS),
    currentState: z.enum(INTEREST_STATES),
    summary: z.string(),
    evidence: z.array(interestEvidenceSchema).max(12),
    narrative: z.string().default(""),
    related: z.array(relatedThreadSchema).max(MAX_RELATED_ROWS).default([]),
  })
  .strict();
export type GateInputInterest = z.output<typeof gateInputInterestSchema>;

const POSITIVE = new Set<InterestEvidenceRole>(["active_signal", "reaffirmed", "current_positive"]);
const NEGATIVE = new Set<InterestEvidenceRole>(["negative_signal", "current_negative"]);
/** Roles that assert where the relationship stands now; automated bulk mail may not carry them. */
const STATE_ROLES: readonly string[] = ["current_positive", "current_negative"];
/** How stale the newest positive signal may be before "active" outruns the mail. */
const STALE_STATE_DAYS = 365;

const latestDay = (rows: readonly { day: string }[]): string =>
  rows
    .map((row) => row.day)
    .sort()
    .at(-1) ?? "";

function correctInterestState(
  source: GateInputInterest,
  evidence: readonly EvidenceRow<InterestEvidenceRole>[],
  context: EvidenceContext,
  counts: RejectionCounts,
): Interest["currentState"] {
  let state: Interest["currentState"] = source.currentState;
  const positive = evidence.filter((row) => POSITIVE.has(row.role));
  const negative = evidence.filter((row) => NEGATIVE.has(row.role));
  const latestPositive = latestDay(positive);
  const latestNegative = latestDay(negative);
  // The latest signal decides; "former" with no negative row is opinion, not fact.
  if (state === "former" && !negative.length) {
    state = "unclear";
    reject(counts, "interest_ungrounded_former_state");
  } else if (latestNegative > latestPositive && state === "active") {
    state = evidence.some((row) => row.role === "current_negative") ? "former" : "unclear";
    reject(counts, "interest_state_corrected_by_later_negative");
  } else if (latestPositive > latestNegative && state === "former") {
    state = "active";
    reject(counts, "interest_state_corrected_by_later_positive");
  }
  // Cancelling one product does not end the provider relationship: if the positive rows name an
  // organization the negative rows never do, "former" is too wide a claim.
  if (state === "former" && context.extractions.size) {
    const positiveOrganizations = observedParties(context, positive, "organization");
    const negativeOrganizations = observedParties(context, negative, "organization");
    if ([...positiveOrganizations].some((org) => !negativeOrganizations.has(org))) {
      state = "unclear";
      reject(counts, "interest_state_corrected_by_child_scope");
    }
  }
  // "Active" expires: measured against the newest mail in the brain, never against wall-clock time.
  const staleActive =
    state === "active" &&
    Boolean(context.cutoff) &&
    Boolean(latestPositive) &&
    countDaysBetween(context.cutoff, latestPositive) > STALE_STATE_DAYS;
  if (staleActive) {
    state = "unclear";
    reject(counts, "interest_stale_active_state");
  }
  return state;
}
export function keepInterestsThatPass(
  proposals: readonly GateInputInterest[],
  context: EvidenceContext,
  allowed: Record<string, Set<string>>,
  counts: RejectionCounts,
): GateRuleResult<Interest> {
  const accepted: Interest[] = [];
  const acceptedProposalIndexes: number[] = [];
  const outcomes: GateRuleResult<Interest>["outcomes"] = [];
  const takenTopics = new Set<string>();
  for (const [proposalIndex, source] of proposals.entries()) {
    const proposalCounts: RejectionCounts = {};
    const finish = (passed: boolean): void => {
      mergeRejections(counts, proposalCounts);
      outcomes.push({
        proposalIndex,
        name: cleanText(source.topic, 160) || "(unnamed interest)",
        passed,
        counters: proposalCounts,
      });
    };
    const checked = keepValidEvidence(source.evidence, allowed, INTEREST_EVIDENCE_ROLES);
    reject(proposalCounts, "interest_invalid_evidence", checked.invalid);
    const evidence = checked.evidence.filter(
      (row) => !STATE_ROLES.includes(row.role) || dayCanCarryState(context, row),
    );
    reject(proposalCounts, "interest_automated_state_evidence", checked.evidence.length - evidence.length);
    if (new Set(evidence.map((row) => row.threadId)).size < 2) {
      reject(proposalCounts, "interest_insufficient_threads");
      finish(false);
      continue;
    }
    // Recurrence means the user's own behavior repeats, in two threads and on two days; several notices
    // from one purchase or incident satisfy neither.
    const positive = evidence.filter((row) => POSITIVE.has(row.role));
    if (new Set(positive.map((row) => row.threadId)).size < 2) {
      reject(proposalCounts, "interest_insufficient_behavioral_threads");
      finish(false);
      continue;
    }
    if (new Set(positive.map((row) => row.day)).size < 2) {
      reject(proposalCounts, "interest_insufficient_distinct_episode_dates");
      finish(false);
      continue;
    }
    const topic = cleanText(source.topic, 160);
    const summary = cleanText(source.summary, 700);
    if (!topic || !summary || takenTopics.has(topic.toLowerCase())) {
      reject(proposalCounts, "interest_duplicate_or_empty");
      finish(false);
      continue;
    }
    takenTopics.add(topic.toLowerCase());
    // A person the user corresponds with belongs in the entity files, not in the interest list.
    const topicKey = normalizeNameKey(topic);
    if (topicKey && evidence.some((row) => context.people[row.threadId]?.has(topicKey))) {
      reject(proposalCounts, "interest_is_person");
      finish(false);
      continue;
    }
    // Direct engagement needs the user in two threads; less is receipts and notices about them.
    const directThreads = new Set(
      positive
        .filter((row) => context.userThreads.has(row.threadId) || dayHasHumanMessage(context, row))
        .map((row) => row.threadId),
    );
    accepted.push({
      topic,
      kind: source.kind,
      currentState: correctInterestState(source, evidence, context, proposalCounts),
      summary,
      firstSeen: firstMessageDay(context, evidence),
      lastSeen: latestDay(evidence),
      engagement: directThreads.size >= 2 ? "direct" : "passive",
      evidence,
      narrative: keepGroundedNarrative(
        source.narrative,
        evidence,
        proposalCounts,
        "interest_narrative_dates_unsupported",
      ),
      related: keepValidRelated(
        source.related,
        context,
        new Set(evidence.map((row) => row.threadId)),
        proposalCounts,
        "interest_related_invalid",
      ),
    });
    acceptedProposalIndexes.push(proposalIndex);
    finish(true);
  }
  return { accepted, acceptedProposalIndexes, outcomes };
}
