// The gate boundary: where a proposed concept list becomes an accepted one, run on the judge's proposals
// and again on the review's answer. No model is called, so a stored concepts.json can be re-derived
// offline, and every rejection is counted by name to explain the gap between proposed and kept.
import { z } from "zod";
import { compareText } from "../shared/text.js";
import {
  reject,
  type ConceptGateResult,
  type EmailThread,
  type RejectionCounts,
  type ThreadExtraction,
} from "../types.js";
import { buildEvidenceContext } from "./evidenceContext.js";
import { dropNearDuplicates, dropSubsumed } from "./dedupeConcepts.js";
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
  })
  .strict();

/** A row that does not parse is counted and skipped; one bad row never fails the list. */
function readProposals<T>(
  document: unknown,
  key: "projects" | "interests",
  schema: z.ZodType<T>,
  counts: RejectionCounts,
): T[] {
  const envelope = z.record(z.string(), z.unknown()).safeParse(document);
  const values = envelope.success ? envelope.data[key] : undefined;
  if (!Array.isArray(values)) {
    reject(counts, `${key.slice(0, -1)}_document_schema`);
    return [];
  }
  return values.flatMap((value) => {
    // Judgments still carry their source cluster; that is not part of the record shape.
    const { cluster: _cluster, ...record } = (value ?? {}) as Record<string, unknown>;
    const row = schema.safeParse(record);
    if (row.success) return [row.data];
    reject(counts, `${key.slice(0, -1)}_schema`);
    return [];
  });
}
/** An alias that equals another project's name would make two concepts answer to one string. */
function removeAliasesThatCollideWithNames(projects: ConceptGateResult["projects"], counts: RejectionCounts): void {
  const names = new Set(projects.map((row) => row.name.toLowerCase()));
  for (const project of projects) {
    const aliases = project.aliases.filter((alias) => !names.has(alias.toLowerCase()));
    reject(counts, "project_alias_name_collision", project.aliases.length - aliases.length);
    project.aliases = aliases;
  }
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
  const passing = {
    projects: keepProjectsThatPass(
      readProposals(projectDocument, "projects", gateInputProjectSchema, rejections),
      context,
      allowed,
      rejections,
    ),
    interests: keepInterestsThatPass(
      readProposals(interestDocument, "interests", gateInputInterestSchema, rejections),
      context,
      allowed,
      rejections,
    ),
  };
  const projects = dropSubsumed(
    dropNearDuplicates(passing.projects, rejections, "project"),
    rejections,
    "project",
    (row) => row.name,
  );
  const interests = dropSubsumed(
    dropNearDuplicates(passing.interests, rejections, "interest"),
    rejections,
    "interest",
    (row) => row.topic,
  );
  removeAliasesThatCollideWithNames(projects, rejections);
  // Code-point ordering keeps generated files byte-stable across locales; localeCompare does not.
  projects.sort((a, b) => compareText(b.lastActivity, a.lastActivity) || compareText(b.name, a.name));
  interests.sort((a, b) => compareText(b.lastSeen, a.lastSeen) || compareText(b.topic, a.topic));
  return {
    projects,
    interests,
    rejections: Object.fromEntries(
      Object.entries(rejections)
        .filter(([, count]) => count > 0)
        .sort(),
    ),
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
