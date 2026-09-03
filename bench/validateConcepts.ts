// Replays concept gates and rendering from cached sources, entirely offline. Three checks, each of which
// can only fail the report: the stored concepts.json survives the gates a second time; re-rendering it
// reproduces the published files byte for byte; and no model or network call happened.
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { z } from "zod";

import { readPublishedBrain, type BrainPaths } from "../src/brain/storage.js";
import { validateStoredConceptDocument } from "../src/concepts/applyGates.js";
import { writeConceptFiles } from "../src/brain/renderConcepts.js";
import type { PipelineContext } from "../src/context.js";
import { readJson } from "../src/shared/atomicFiles.js";
import type { ConceptReviewLog, ConceptTrace } from "../src/types.js";
import { brainMetaSchema, loadCachedBrain } from "./publishedBrain.js";
import { runAsScript } from "./script.js";

const summarySchema = z
  .object({
    projects: z.array(z.object({ evidence: z.array(z.unknown()) }).passthrough()),
    interests: z.array(z.object({ evidence: z.array(z.unknown()) }).passthrough()),
    rejected: z.record(z.string(), z.number().int().nonnegative()),
  })
  .passthrough();

interface Tree {
  files: Map<string, Buffer>;
  symlinks: number;
}

interface Drift {
  missing: string[];
  unexpected: string[];
  changed: string[];
}

function tree(root: string): Tree {
  const result: Tree = { files: new Map(), symlinks: 0 };
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) result.symlinks += 1;
      else if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result.files.set(relative(root, path).split(sep).join("/"), readFileSync(path));
    }
  }
  visit(root);
  return result;
}

function conceptTree(root: string): Tree {
  const files = new Map<string, Buffer>();
  let symlinks = 0;
  for (const name of ["projects", "interests", "concepts"]) {
    if (!existsSync(join(root, name))) continue;
    const part = tree(join(root, name));
    symlinks += part.symlinks;
    for (const [key, value] of part.files) files.set(`${name}/${key}`, value);
  }
  return { files, symlinks };
}

const links = (rows: readonly { evidence: readonly unknown[] }[]): number =>
  rows.reduce((sum, row) => sum + row.evidence.length, 0);

function failed(present: boolean, issue: string) {
  return {
    schema_version: 1,
    status: present ? "failed" : "concepts_absent",
    concepts_present: present,
    gate_passed: false,
    model_calls_made: 0,
    network_calls_made: 0,
    counts: {},
    issue_counts: present ? { [issue]: 1 } : {},
    file_drift: { missing: [], unexpected: [], changed: [] } as Drift,
  };
}

/** Whether the tree has a concept layer at all, and whether it is shaped safely enough to read. */
function inspectConceptFiles(paths: BrainPaths): "absent" | "unsafe" | "ok" {
  const anyPresent = existsSync(paths.projectsDir) || existsSync(paths.interestsDir) || existsSync(paths.conceptsFile);
  if (!anyPresent) return "absent";
  const directories = [paths.projectsDir, paths.interestsDir].every(
    (dir) => existsSync(dir) && lstatSync(dir).isDirectory(),
  );
  const document = existsSync(paths.conceptsFile) && lstatSync(paths.conceptsFile).isFile();
  return directories && document ? "ok" : "unsafe";
}

interface RenderComparison {
  drift: Drift;
  rendered: number;
  symlinks: number;
}

function compareRenderedFiles(
  gated: ReturnType<typeof validateStoredConceptDocument>,
  rejected: Record<string, number>,
  review: ConceptReviewLog | undefined,
  trace: ConceptTrace[] | undefined,
  publishedRoot: string,
): RenderComparison {
  const temporary = mkdtempSync(join(tmpdir(), "roze-concept-validation-"));
  try {
    writeConceptFiles(gated.projects, gated.interests, rejected, temporary, review, trace);
    const expected = conceptTree(temporary);
    const actual = conceptTree(publishedRoot);
    return {
      rendered: expected.files.size,
      symlinks: expected.symlinks + actual.symlinks,
      drift: {
        missing: [...expected.files.keys()].filter((path) => !actual.files.has(path)).sort(),
        unexpected: [...actual.files.keys()].filter((path) => !expected.files.has(path)).sort(),
        changed: [...expected.files.keys()]
          .filter((path) => actual.files.has(path) && !expected.files.get(path)!.equals(actual.files.get(path)!))
          .sort(),
      },
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** A throwing model function proves validation cannot silently make a paid or network call. */
function offlineContext(paths: BrainPaths, today: string): PipelineContext {
  return {
    paths,
    today,
    log: () => undefined,
    callModel: async () => {
      throw new Error("validation requires a complete extraction cache");
    },
  };
}

async function validateConcepts(brainRoot?: string) {
  const published = readPublishedBrain(brainRoot);
  const paths = published.paths;
  const presence = inspectConceptFiles(paths);
  if (presence === "absent") return failed(false, "concepts_absent");
  if (presence === "unsafe") return failed(true, "concept_document_missing_or_unsafe");

  const document = readJson(paths.conceptsFile);
  const summary = summarySchema.safeParse(document);
  const meta = brainMetaSchema.safeParse(readJson(paths.metaFile));
  if (!summary.success || !meta.success) return failed(true, "stored_document_invalid");

  // Body-only evidence (backfilled raw threads) was never extracted, but receipts and related threads cite it.
  let cached;
  try {
    const context = offlineContext(paths, meta.data.generatedAt);
    cached = await loadCachedBrain(paths, published.timezone, meta.data.userEmail, context);
  } catch {
    return failed(true, "source_cache_invalid");
  }
  const { everyThread, extractions } = cached;

  let gated;
  try {
    gated = validateStoredConceptDocument(document, everyThread, extractions, undefined, meta.data.userEmail);
  } catch {
    return failed(true, "stored_document_invalid");
  }

  const issues: Record<string, number> = {};
  const rejectionCount = Object.values(gated.rejections).reduce((sum, count) => sum + count, 0);
  if (rejectionCount) issues.stored_revalidation_rejections = rejectionCount;
  for (const [name, value] of Object.entries(gated.rejections)) issues[`revalidation_${name}`] = value;
  const unchanged =
    isDeepStrictEqual(gated.projects, summary.data.projects) &&
    isDeepStrictEqual(gated.interests, summary.data.interests);
  if (!unchanged) issues.stored_collections_changed_on_revalidation = 1;

  const review = (document as { review?: ConceptReviewLog }).review;
  const trace = (document as { trace?: ConceptTrace[] }).trace;
  const comparison = compareRenderedFiles(gated, summary.data.rejected, review, trace, paths.root);
  for (const [key, rows] of Object.entries(comparison.drift))
    if (rows.length) issues[`rendered_files_${key}`] = rows.length;
  if (comparison.symlinks) issues.rendered_symlinks = comparison.symlinks;

  const passed = !Object.keys(issues).length;
  return {
    schema_version: 1,
    status: passed ? "passed" : "failed",
    concepts_present: true,
    gate_passed: passed,
    model_calls_made: 0,
    network_calls_made: 0,
    counts: {
      cached_source_threads: everyThread.length,
      cached_extractions: extractions.length,
      stored_projects: summary.data.projects.length,
      stored_interests: summary.data.interests.length,
      stored_evidence_links: links(summary.data.projects) + links(summary.data.interests),
      stored_prior_rejections: Object.values(summary.data.rejected).reduce((sum, count) => sum + count, 0),
      revalidated_projects: gated.projects.length,
      revalidated_interests: gated.interests.length,
      revalidated_evidence_links: links(gated.projects) + links(gated.interests),
      rendered_files: comparison.rendered,
    },
    issue_counts: Object.fromEntries(Object.entries(issues).sort()),
    file_drift: comparison.drift,
  };
}

runAsScript(
  import.meta.url,
  async () => {
    const { values } = parseArgs({ options: { brain: { type: "string" } }, strict: true });
    try {
      const report = await validateConcepts(values.brain);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.gate_passed ? 0 : 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const report = { status: "failed", gate_passed: false, error: message };
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = 1;
    }
  },
  "Concept validation",
);
