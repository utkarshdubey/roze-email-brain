// What comes back from the review pass, trusted none of it: a demotion is honoured only when the
// concept's own evidence agrees with the stated reason, an entry may cite only what its members cite plus
// the extra context it named, and a concept the model never mentioned survives untouched rather than
// quietly disappearing. Both lists go through the same `applyVerdicts`, so the layers cannot drift apart.
import { z } from "zod";
import type { PipelineContext } from "../context.js";
import { MODELS, readCacheOrCall, type CachedModelRequest } from "../llm/models.js";
import { countDaysBetween } from "../shared/dates.js";
import { cleanText } from "../shared/text.js";
import {
  mergeRejections,
  reject,
  type Citation,
  type ConceptReviewLog,
  type ConceptReviewOutcome,
  type EvidenceRow,
  type Interest,
  type MerchantRow,
  type OpenLoopRow,
  type Project,
  type RejectionCounts,
  type ProposedInterest,
  type ProposedProject,
  type ProjectTrack,
} from "../types.js";
import {
  buildInterestReviewRequest,
  buildProjectReviewRequest,
  ref,
  type InterestReviewDocument,
  type ProjectReviewDocument,
} from "./reviewRequests.js";

const MEDIUM_EFFORT_MAX_CHARS = 30_000;
const MAX_EVIDENCE = 12;
/** A demotion must be checkable: an episode is short, marketing was never replied to. */
const EPISODE_DAYS = 30;

const emptyReviewLog = (): ConceptReviewLog => ({ merged: [], demoted: [], rejections: {} });
const parseRef = (value: string): Citation | undefined => {
  const [threadId, day] = value.split("::");
  return threadId && day ? { threadId, day } : undefined;
};
const spanDays = (rows: readonly { day: string }[]): number => {
  const days = rows.map((row) => row.day).sort();
  return days.length ? countDaysBetween(days.at(-1)!, days[0]!) : 0;
};

// VERDICT MECHANICS — shared by both layers, so projects and interests cannot drift apart.

interface Verdict {
  id: string;
  members: string[];
  evidence: { source_ref: string; role: string; reason: string }[];
}
interface Demotion {
  id: string;
  reason: string;
}
interface VerdictHandlers<Concept, Entry extends Verdict, Proposal> {
  prefix: string;
  counter: string;
  nameOf: (concept: Concept) => string;
  nameOfProposal: (proposal: Proposal) => string;
  keep: (concept: Concept) => Proposal;
  verdict: (entry: Entry, members: readonly Concept[]) => ConceptReviewOutcome["verdict"];
  /** Whether the concept's own evidence agrees with the stated demotion reason. */
  supported: (concept: Concept, reason: string) => boolean;
  /** Citable refs this entry named beyond its members: an open loop, a merchant's receipts. */
  extraRefs: (entry: Entry) => Set<string>;
  build: (
    entry: Entry,
    members: Concept[],
    evidence: EvidenceRow<string>[],
    allowed: ReadonlySet<string>,
  ) => Proposal;
}
/**
 * A demoted id is removed; each entry claims its members (first claim wins, later claims are counted) and
 * may cite only what they cite plus the extra refs it named; every unmentioned concept is kept unchanged.
 */
function applyVerdicts<Concept extends { evidence: EvidenceRow<string>[] }, Entry extends Verdict, Proposal>(
  concepts: readonly Concept[],
  entries: readonly Entry[],
  demotions: readonly Demotion[],
  log: ConceptReviewLog,
  handlers: VerdictHandlers<Concept, Entry, Proposal>,
): { proposals: Proposal[]; log: ConceptReviewLog; outcomes: ConceptReviewOutcome[] } {
  const counts = log.rejections;
  const byId = new Map(
    concepts.map((concept, inputIndex) => [`${handlers.prefix}${inputIndex + 1}`, { concept, inputIndex }]),
  );
  const consumed = new Set<string>();
  const proposals: Proposal[] = [];
  const outcomes: ConceptReviewOutcome[] = [];
  for (const demotion of demotions) {
    const indexed = byId.get(demotion.id);
    if (!indexed || consumed.has(demotion.id)) {
      reject(counts, "review_conflicting_verdict");
      continue;
    }
    // A demotion is a deletion, so it must be checkable against the concept's own rows.
    if (!handlers.supported(indexed.concept, demotion.reason)) {
      reject(counts, "review_demotion_unsupported");
      continue;
    }
    consumed.add(demotion.id);
    const name = handlers.nameOf(indexed.concept);
    log.demoted.push({ name, reason: demotion.reason });
    outcomes.push({ inputIndex: indexed.inputIndex, name, verdict: "demoted", reason: demotion.reason });
    reject(counts, `${handlers.counter}_${demotion.reason}`);
  }
  for (const entry of entries) {
    const claimed = claimMembers(entry, byId, consumed, counts);
    if (!claimed.length && entry.id !== "new") continue;
    const members = claimed.map((member) => member.concept);
    const allowed = new Set([...handlers.extraRefs(entry), ...members.flatMap((member) => member.evidence.map(ref))]);
    const evidence = collectEntryEvidence(entry, members, allowed, counts);
    const proposal = handlers.build(entry, members, evidence.slice(0, MAX_EVIDENCE), allowed);
    const outputIndex = proposals.length;
    proposals.push(proposal);
    const verdict = handlers.verdict(entry, members);
    const into = handlers.nameOfProposal(proposal);
    for (const member of claimed) {
      outcomes.push({
        inputIndex: member.inputIndex,
        name: handlers.nameOf(member.concept),
        verdict,
        ...(verdict === "kept" ? {} : { into }),
        outputIndex,
      });
    }
  }
  byId.forEach(({ concept, inputIndex }, id) => {
    if (!consumed.has(id)) {
      const outputIndex = proposals.length;
      proposals.push(handlers.keep(concept));
      outcomes.push({ inputIndex, name: handlers.nameOf(concept), verdict: "kept", outputIndex });
    }
  });
  outcomes.sort((left, right) => left.inputIndex - right.inputIndex);
  return { proposals, log, outcomes };
}
/** An id may be folded into one entry only; a second claim is a conflicting verdict, not a merge. */
function claimMembers<Concept, Entry extends Verdict>(
  entry: Entry,
  byId: ReadonlyMap<string, { concept: Concept; inputIndex: number }>,
  consumed: Set<string>,
  counts: RejectionCounts,
): Array<{ concept: Concept; inputIndex: number }> {
  const members: Array<{ concept: Concept; inputIndex: number }> = [];
  for (const id of new Set(entry.id === "new" ? entry.members : [entry.id, ...entry.members])) {
    if (consumed.has(id)) {
      reject(counts, "review_conflicting_verdict");
      continue;
    }
    consumed.add(id);
    members.push(byId.get(id)!);
  }
  return members;
}
function collectEntryEvidence<Concept extends { evidence: EvidenceRow<string>[] }>(
  entry: Verdict,
  members: readonly Concept[],
  allowed: ReadonlySet<string>,
  counts: RejectionCounts,
): EvidenceRow<string>[] {
  const seen = new Set<string>();
  const evidence: EvidenceRow<string>[] = [];
  const push = (row: EvidenceRow<string>): void => {
    const key = `${ref(row)}\0${row.role}`;
    if (!seen.has(key)) {
      seen.add(key);
      evidence.push(row);
    }
  };
  for (const row of entry.evidence) {
    const citation = parseRef(row.source_ref);
    if (citation && allowed.has(row.source_ref)) {
      push({ ...citation, role: row.role, reason: row.reason });
    } else {
      reject(counts, "review_evidence_outside_members");
    }
  }
  for (const member of members) {
    for (const row of member.evidence) push(row);
  }
  return evidence;
}

// PROJECT AND INTEREST VERDICTS — the layer-specific halves.

const stripProject = ({ firstSeen: _firstSeen, lastActivity: _lastActivity, ...row }: Project): ProposedProject => row;
const stripInterest = ({
  firstSeen: _firstSeen,
  lastSeen: _lastSeen,
  engagement: _engagement,
  ...row
}: Interest): ProposedInterest => row;
const union = (values: readonly string[], limit: number): string[] => [...new Set(values)].slice(0, limit);

export function applyProjectReview(
  projects: readonly Project[],
  loops: readonly OpenLoopRow[],
  document: ProjectReviewDocument,
) {
  const loopRefs = new Set(loops.map(ref));
  const log = emptyReviewLog();
  type ProjectEntry = ProjectReviewDocument["projects"][number];
  /** A track cites one day, and it must be one the umbrella's own members (or a named loop) already cite. */
  const buildTracks = (entry: ProjectEntry, allowed: ReadonlySet<string>): ProjectTrack[] =>
    entry.tracks.flatMap((track) => {
      const citation = parseRef(track.source_ref);
      if (!citation || !allowed.has(track.source_ref)) {
        reject(log.rejections, "project_track_outside_members");
        return [];
      }
      const outcome = cleanText(track.outcome, 300);
      return [{ name: cleanText(track.name, 120), status: track.status, outcome, ...citation }];
    });
  return applyVerdicts(projects, document.projects, document.demoted, log, {
    prefix: "P",
    counter: "project_demoted",
    nameOf: (project) => project.name,
    nameOfProposal: (project) => cleanText(project.name, 160),
    keep: stripProject,
    verdict: (entry, members) =>
      entry.tracks.length && members.length
        ? "umbrella"
        : members.length > 1 || (entry.id === "new" && members.length)
          ? "merged"
          : "kept",
    // A month-long effort is not a single incident, whatever the model says.
    supported: (project, reason) =>
      reason !== "single_incident_or_ticket" || spanDays(project.evidence) < EPISODE_DAYS,
    extraRefs: () => loopRefs,
    build: (entry, members, evidence, allowed) => {
      const tracks = buildTracks(entry, allowed);
      if (members.length > 1 || (entry.id === "new" && members.length))
        log.merged.push({ into: cleanText(entry.name, 160), members: members.map((member) => member.name) });
      return {
        name: entry.name,
        aliases: union([...entry.aliases, ...members.flatMap((member) => member.aliases)], 4),
        goal: entry.goal,
        status: entry.status,
        outcome: entry.outcome,
        people: union([...entry.people, ...members.flatMap((member) => member.people)], 8),
        organizations: union([...entry.organizations, ...members.flatMap((member) => member.organizations)], 4),
        evidence,
        narrative: entry.narrative,
        tracks,
        related: members.flatMap((member) => member.related),
      } as ProposedProject;
    },
  });
}
export function applyInterestReview(
  interests: readonly Interest[],
  merchants: readonly MerchantRow[],
  document: InterestReviewDocument,
) {
  const merchantById = new Map(merchants.map((merchant, index) => [`M${index + 1}`, merchant]));
  const log = emptyReviewLog();
  const chosenMerchants = (entry: InterestReviewDocument["interests"][number]): MerchantRow[] =>
    [...new Set(entry.merchants)].flatMap((id) => merchantById.get(id) ?? []);
  return applyVerdicts(interests, document.interests, document.dropped, log, {
    prefix: "I",
    counter: "interest_dropped",
    nameOf: (interest) => interest.topic,
    nameOfProposal: (interest) => cleanText(interest.topic, 160),
    keep: stripInterest,
    verdict: (entry, members) =>
      members.length > 1 || chosenMerchants(entry).length || (entry.id === "new" && members.length)
        ? "merged"
        : "kept",
    // Marketing-only means the user never wrote back; a single episode means it all happened within a month.
    supported: (interest, reason) =>
      reason === "marketing_only" ? interest.engagement === "passive" : spanDays(interest.evidence) < EPISODE_DAYS,
    extraRefs: (entry) => new Set(chosenMerchants(entry).flatMap((merchant) => merchant.examples.map(ref))),
    build: (entry, members, evidence) => {
      const receipts = chosenMerchants(entry);
      if (members.length > 1 || receipts.length || (entry.id === "new" && members.length))
        log.merged.push({
          into: cleanText(entry.topic, 160),
          members: [
            ...members.map((member) => member.topic),
            ...receipts.map((merchant) => `receipts: ${merchant.merchant}`),
          ],
        });
      return {
        topic: entry.topic,
        kind: entry.kind,
        currentState: entry.current_state,
        summary: entry.summary,
        evidence,
        narrative: entry.narrative,
        related: members.flatMap((member) => member.related),
      } as ProposedInterest;
    },
  });
}

// THE PASS — two calls at most, each skipped when its list is empty.

function reviewRequest<Output>(
  system: string,
  user: string,
  schema: z.ZodType<Output>,
  context: PipelineContext,
): CachedModelRequest<Output> {
  // Medium consolidates better on the short project list; the cache layer retries at low if it loops.
  return {
    kind: "review",
    system,
    user,
    schema,
    model: MODELS.judge,
    effort: user.length <= MEDIUM_EFFORT_MAX_CHARS ? "medium" : "low",
    cacheDir: context.paths.cachedConceptsDir,
  };
}
export async function reviewConcepts(
  projects: readonly Project[],
  interests: readonly Interest[],
  loops: readonly OpenLoopRow[],
  merchants: readonly MerchantRow[],
  userEmail: string,
  context: PipelineContext,
) {
  const log = emptyReviewLog();
  const absorb = (part: ConceptReviewLog, truncated: boolean): void => {
    log.merged.push(...part.merged);
    log.demoted.push(...part.demoted);
    mergeRejections(log.rejections, part.rejections);
    if (truncated) {
      reject(log.rejections, "review_input_truncated");
    }
  };
  /** Threads the review was allowed to cite beyond the clusters: loops and merchant receipts. */
  const extra = new Set<string>();
  let reviewedProjects = projects.map(stripProject);
  let reviewedInterests = interests.map(stripInterest);
  let projectOutcomes: ConceptReviewOutcome[] = projects.map((project, inputIndex) => ({
    inputIndex,
    name: project.name,
    verdict: "kept",
    outputIndex: inputIndex,
  }));
  let interestOutcomes: ConceptReviewOutcome[] = interests.map((interest, inputIndex) => ({
    inputIndex,
    name: interest.topic,
    verdict: "kept",
    outputIndex: inputIndex,
  }));
  context.log("reviewing", 0, 2);
  if (projects.length) {
    const request = buildProjectReviewRequest(projects, loops, userEmail, context.today);
    const document = await readCacheOrCall(
      reviewRequest(request.system, request.user, request.schema, context),
      context.callModel,
    );
    const applied = applyProjectReview(projects, request.loops, document);
    reviewedProjects = applied.proposals;
    projectOutcomes = applied.outcomes;
    absorb(applied.log, request.truncated);
    for (const loop of request.loops) {
      extra.add(loop.threadId);
    }
  }
  context.log("reviewing", 1, 2);
  if (interests.length) {
    const request = buildInterestReviewRequest(interests, merchants, userEmail, context.today);
    const document = await readCacheOrCall(
      reviewRequest(request.system, request.user, request.schema, context),
      context.callModel,
    );
    const applied = applyInterestReview(interests, request.merchants, document);
    reviewedInterests = applied.proposals;
    interestOutcomes = applied.outcomes;
    absorb(applied.log, request.truncated);
    for (const merchant of request.merchants) {
      for (const example of merchant.examples) {
        extra.add(example.threadId);
      }
    }
  }
  context.log("reviewing", 2, 2);
  return {
    projects: reviewedProjects,
    interests: reviewedInterests,
    log,
    extraThreadIds: [...extra].sort(),
    outcomes: { projects: projectOutcomes, interests: interestOutcomes },
  };
}
