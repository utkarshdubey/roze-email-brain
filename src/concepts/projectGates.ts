// The deterministic rules a proposed PROJECT — an outcome-oriented effort — must pass. Every failure
// increments a named counter that ends up in concepts.json, so a missing project traces to the rule that
// dropped it, and the rules run in the order written so a project rejected for having too few threads is
// never also counted as having an ungrounded goal.
import { z } from "zod";
import { countDaysBetween } from "../shared/dates.js";
import { cleanText, normalizeNameKey, wordsFromText } from "../shared/text.js";
import {
  PROJECT_EVIDENCE_ROLES,
  PROJECT_STATUSES,
  reject,
  type EvidenceRow,
  type Project,
  type ProjectEvidenceRole,
  type ProjectTrack,
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

const projectEvidenceSchema = z
  .object({ threadId: z.string(), day: z.string(), reason: z.string(), role: z.enum(PROJECT_EVIDENCE_ROLES) })
  .strict();
const trackSchema = z
  .object({
    name: z.string(),
    status: z.enum(PROJECT_STATUSES),
    outcome: z.string(),
    threadId: z.string(),
    day: z.string(),
  })
  .strict();
export const gateInputProjectSchema = z
  .object({
    name: z.string(),
    aliases: z.array(z.string()).max(4),
    goal: z.string(),
    status: z.enum(PROJECT_STATUSES),
    outcome: z.string(),
    people: z.array(z.string()).max(8),
    organizations: z.array(z.string()).max(4),
    evidence: z.array(projectEvidenceSchema).max(12),
    narrative: z.string().default(""),
    tracks: z.array(trackSchema).max(8).default([]),
    related: z.array(relatedThreadSchema).max(MAX_RELATED_ROWS).default([]),
  })
  .strict();
export type GateInputProject = z.output<typeof gateInputProjectSchema>;

/** Roles asserting where the project stands; only a person or a case system may carry them. */
const PROJECT_STATE_ROLES = new Set<ProjectEvidenceRole>(["progress", "current_state", "outcome"]);
/** Names that give away an open loop wearing a project's clothes: one ticket, one order, one verification. */
const LOOP_LIKE = new RegExp(
  String.raw`\b(refund|verification|verify|access|receipt|invoice|password|nda|beta|premium|coupon|` +
    String.raw`delivery|shipment|order \d+|case \d+|ticket \d+|otp|login)\b`,
  "i",
);
/** A brief effort is still an effort when the user drove it across threads; notices are not. */
const MINIMUM_SPAN_DAYS = 14;
/** How stale a state row may be before "active" outruns the mail. */
const STALE_STATE_DAYS = 365;

function cleanUniqueNames(values: readonly string[], limit: number, exclude = ""): string[] {
  const seen = new Set(exclude ? [exclude.toLowerCase()] : []);
  const kept: string[] = [];
  for (const value of values) {
    const name = cleanText(value, limit);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    kept.push(name);
  }
  return kept;
}
/** Only names extraction saw in the cited threads, so the model cannot import a plausible one. */
function keepGroundedParties(
  context: EvidenceContext,
  values: readonly string[],
  evidence: readonly { threadId: string }[],
  kind: "person" | "organization",
): string[] {
  if (!context.extractions.size) return [...values];
  const observed = observedParties(context, evidence, kind);
  return values.filter((value) => observed.has(value.toLowerCase()));
}
/** "Erin W." and "Erin Wilson" are one person; the fuller name wins so each party is listed once. */
function removeShortNameVariants(names: readonly string[]): { names: string[]; dropped: number } {
  const tokens = new Map(names.map((name) => [name, wordsFromText(name)]));
  const abbreviates = (short: string, long: string): boolean =>
    short !== long && tokens.get(short)!.every((part) => tokens.get(long)!.some((word) => word.startsWith(part)));
  const longestFirst = [...names].sort(
    (a, b) => tokens.get(b)!.length - tokens.get(a)!.length || b.length - a.length || a.localeCompare(b),
  );
  const kept: string[] = [];
  for (const name of longestFirst) {
    if (!kept.some((other) => abbreviates(name, other))) kept.push(name);
  }
  const result = names.filter((name) => kept.includes(name));
  return { names: result, dropped: names.length - result.length };
}
function keepGroundedParticipants(
  source: GateInputProject,
  evidence: readonly EvidenceRow<ProjectEvidenceRole>[],
  context: EvidenceContext,
  counts: RejectionCounts,
): { people: string[]; organizations: string[] } {
  const people = cleanUniqueNames(source.people, 160);
  const organizations = cleanUniqueNames(source.organizations, 160);
  const groundedPeople = keepGroundedParties(context, people, evidence, "person");
  const groundedOrganizations = keepGroundedParties(context, organizations, evidence, "organization");
  reject(
    counts,
    "project_ungrounded_participant",
    people.length - groundedPeople.length + organizations.length - groundedOrganizations.length,
  );
  // The mailbox owner is the subject of the brain, never a listed participant.
  const withoutSelf = groundedPeople.filter((person) => !context.self.has(normalizeNameKey(person)));
  reject(counts, "project_self_participant", groundedPeople.length - withoutSelf.length);
  const deduped = removeShortNameVariants(withoutSelf);
  reject(counts, "project_duplicate_participant", deduped.dropped);
  return { people: deduped.names, organizations: groundedOrganizations };
}
/** An alias is only kept when it literally appears in the text of a cited thread. */
function keepGroundedAliases(
  source: GateInputProject,
  name: string,
  evidence: readonly EvidenceRow<ProjectEvidenceRole>[],
  context: EvidenceContext,
  counts: RejectionCounts,
): string[] {
  const aliases = cleanUniqueNames(source.aliases, 160, name);
  const grounded = aliases.filter((alias) =>
    evidence.some((row) => context.text[row.threadId]?.includes(alias.toLowerCase())),
  );
  reject(counts, "project_ungrounded_alias", aliases.length - grounded.length);
  return grounded;
}
/** Each track cites exactly one day, and that day must be one the model was shown. */
function keepValidTracks(
  source: GateInputProject,
  allowed: Record<string, Set<string>>,
  counts: RejectionCounts,
): ProjectTrack[] {
  const tracks: ProjectTrack[] = [];
  const takenNames = new Set<string>();
  for (const track of source.tracks) {
    const name = cleanText(track.name, 120);
    const key = name.toLowerCase();
    if (!name || takenNames.has(key) || !allowed[track.threadId]?.has(track.day)) {
      reject(counts, "project_track_invalid");
      continue;
    }
    takenNames.add(key);
    tracks.push({
      name,
      status: track.status,
      outcome: cleanText(track.outcome, 300),
      threadId: track.threadId,
      day: track.day,
    });
  }
  return tracks;
}
/** Status and outcome are claims about the present; both drop to what the rows support. */
function correctProjectState(
  source: GateInputProject,
  evidence: readonly EvidenceRow<ProjectEvidenceRole>[],
  context: EvidenceContext,
  counts: RejectionCounts,
): { outcome: string; status: Project["status"] } {
  const roles = new Set(evidence.map((row) => row.role));
  let outcome = cleanText(source.outcome, 600);
  let status: Project["status"] = source.status;
  if (outcome && !roles.has("outcome")) {
    outcome = "";
    reject(counts, "project_ungrounded_outcome");
  }
  if (status === "completed" && !roles.has("outcome")) {
    status = "unknown";
    reject(counts, "project_completed_without_outcome");
  }
  if (status !== "unknown" && !roles.has("current_state") && !roles.has("outcome")) {
    status = "unknown";
    reject(counts, "project_ungrounded_status");
  }
  // "Active" is a claim about now, so it expires: newest state row against newest mail.
  const stateDay = evidence
    .filter((row) => row.role === "current_state" || row.role === "outcome")
    .map((row) => row.day)
    .sort()
    .at(-1);
  const staleActive =
    status === "active" &&
    Boolean(context.cutoff) &&
    Boolean(stateDay) &&
    countDaysBetween(context.cutoff, stateDay!) > STALE_STATE_DAYS;
  if (staleActive) {
    status = "unknown";
    reject(counts, "project_stale_active_state");
  }
  return { outcome, status };
}
export function keepProjectsThatPass(
  proposals: readonly GateInputProject[],
  context: EvidenceContext,
  allowed: Record<string, Set<string>>,
  counts: RejectionCounts,
): Project[] {
  const accepted: Project[] = [];
  const takenNames = new Set<string>();
  for (const source of proposals) {
    const checked = keepValidEvidence(source.evidence, allowed, PROJECT_EVIDENCE_ROLES);
    reject(counts, "project_invalid_evidence", checked.invalid);
    const evidence = checked.evidence.filter(
      (row) => !PROJECT_STATE_ROLES.has(row.role) || dayCanCarryState(context, row),
    );
    reject(counts, "project_automated_state_evidence", checked.evidence.length - evidence.length);
    // One thread is an episode, however many messages it holds; an effort crosses threads.
    if (new Set(evidence.map((row) => row.threadId)).size < 2) {
      reject(counts, "project_insufficient_threads");
      continue;
    }
    const name = cleanText(source.name, 160);
    const goal = cleanText(source.goal, 600);
    if (!name || !goal || takenNames.has(name.toLowerCase())) {
      reject(counts, "project_duplicate_or_empty");
      continue;
    }
    takenNames.add(name.toLowerCase());
    // The goal row is what makes a project a project; without one there is nothing to drive toward.
    if (!evidence.some((row) => row.role === "goal")) {
      reject(counts, "project_ungrounded_goal");
      continue;
    }
    if (LOOP_LIKE.test(name)) {
      reject(counts, "project_loop_like_name");
      continue;
    }
    const dates = evidence.map((row) => row.day).sort();
    const drivenByUser = new Set(evidence.map((row) => row.threadId).filter((id) => context.userThreads.has(id)));
    if (countDaysBetween(dates.at(-1)!, dates[0]!) < MINIMUM_SPAN_DAYS && drivenByUser.size < 2) {
      reject(counts, "project_too_brief");
      continue;
    }
    const state = correctProjectState(source, evidence, context, counts);
    const parties = keepGroundedParticipants(source, evidence, context, counts);
    const tracks = keepValidTracks(source, allowed, counts);
    const cited = new Set([...evidence.map((row) => row.threadId), ...tracks.map((row) => row.threadId)]);
    // Last activity prefers the newest day a person wrote: an automated tail keeps nothing alive.
    const humanDates = evidence.filter((row) => dayHasHumanMessage(context, row)).map((row) => row.day);
    accepted.push({
      name,
      aliases: keepGroundedAliases(source, name, evidence, context, counts),
      goal,
      status: state.status,
      outcome: state.outcome,
      people: parties.people,
      organizations: parties.organizations,
      firstSeen: firstMessageDay(context, evidence),
      lastActivity: (humanDates.length ? humanDates : dates).sort().at(-1)!,
      evidence,
      narrative: keepGroundedNarrative(source.narrative, evidence, counts, "project_narrative_dates_unsupported"),
      tracks,
      related: keepValidRelated(source.related, context, cited, counts, "project_related_invalid"),
    });
  }
  return accepted;
}
