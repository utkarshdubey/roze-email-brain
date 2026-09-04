// Published and account-scoped cache paths in one place, so writers and retrieval share one allowlist,
// plus the staged swap `generate` publishes through, with its Windows retry and its rollback.
import { lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDirectory, loadEnvironmentFile, readJson } from "../shared/atomicFiles.js";
import type { OffsetTimeline } from "../shared/dates.js";

/** Scoped by account, so switching sign-ins in one brain directory never mixes two inboxes. */
function cacheDirectoryFor(brainRoot: string, account?: string): string {
  const safe = (account ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@._-]/gu, "_");
  return safe ? join(brainRoot, ".cache", safe) : join(brainRoot, ".cache");
}

export function resolveBrainPaths(root?: string, account?: string) {
  loadEnvironmentFile();
  const configured = root ?? process.env.ROZE_BRAIN_DIR ?? "brain";
  const brainRoot = resolve(configured || "brain");
  const cacheDir = cacheDirectoryFor(brainRoot, account);
  const evidenceDir = join(brainRoot, "evidence");
  return {
    root: brainRoot,
    indexFile: join(brainRoot, "INDEX.md"),
    metaFile: join(brainRoot, "meta.json"),
    evidenceDir,
    evidenceThreadsDir: join(evidenceDir, "threads"),
    projectsDir: join(brainRoot, "projects"),
    interestsDir: join(brainRoot, "interests"),
    conceptsDir: join(brainRoot, "concepts"),
    conceptsFile: join(brainRoot, "concepts.json"),
    threadsDir: join(brainRoot, "threads"),
    cacheDir,
    cachedThreadsDir: join(cacheDir, "threads"),
    cachedHeadersFile: join(cacheDir, "headers.jsonl"),
    cachedPromotionFile: join(cacheDir, "promotion.json"),
    cachedOnDemandFile: join(cacheDir, "on-demand.txt"),
    cachedExtractionsDir: join(cacheDir, "extractions"),
    cachedConceptsDir: join(cacheDir, "concepts"),
    searchIndexFile: join(cacheDir, "search.sqlite"),
  };
}

export type BrainPaths = ReturnType<typeof resolveBrainPaths>;

/** The offset timeline the published brain was rendered by; empty (UTC) for brains that predate it. */
export function readPublishedBrain(root?: string): { paths: BrainPaths; userEmail: string; timezone: OffsetTimeline } {
  const unscoped = resolveBrainPaths(root);
  const meta = readJson(unscoped.metaFile) as { userEmail?: unknown; timezone?: unknown } | undefined;
  const userEmail = typeof meta?.userEmail === "string" ? meta.userEmail : "";
  return {
    paths: userEmail ? resolveBrainPaths(root, userEmail) : unscoped,
    userEmail,
    timezone: Array.isArray(meta?.timezone) ? (meta.timezone as OffsetTimeline) : [],
  };
}

export const RUBRIC_DIRECTORIES = ["people", "organizations", "projects", "interests", "open_loops"] as const;
export const SEARCH_SCOPES = [...RUBRIC_DIRECTORIES, "thread_summaries", "transactions", "evidence", "all"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const VIEW_GLOBS_BY_SCOPE: Record<SearchScope, string[]> = {
  people: ["people/*"],
  organizations: ["organizations/*"],
  projects: ["projects/*"],
  interests: ["interests/*"],
  open_loops: ["open_loops/*"],
  thread_summaries: ["threads/*", "evidence/threads-*.md", "evidence/inbox-*.md"],
  transactions: ["evidence/transactions-*.md"],
  evidence: ["evidence/threads/*"],
  all: [
    "INDEX.md",
    ...RUBRIC_DIRECTORIES.map((name) => `${name}/*`),
    "concepts/*",
    "threads/*",
    "evidence/*.md",
    "evidence/threads/*",
  ],
};

export const PUBLISH_TARGETS = [
  "evidence",
  "threads",
  "concepts",
  ...RUBRIC_DIRECTORIES,
  "INDEX.md",
  "meta.json",
  "concepts.json",
] as const;
type PublishTarget = (typeof PUBLISH_TARGETS)[number];

interface PublishOperations {
  rename(source: string, destination: string): void;
  remove(path: string): void;
}

const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
const RENAME_ATTEMPTS = 15;

/** The swap is synchronous, so it cannot await; a blocking sleep needs no dependency. */
function sleepSynchronously(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Windows reports EPERM when another process holds a handle inside a directory being renamed (a `roze
 * prompt` reading the brain, Defender scanning fresh files). Those holds last milliseconds to seconds,
 * so the swap waits and retries, about six seconds in all.
 */
export function renameWithRetry(
  source: string,
  destination: string,
  rename: (from: string, to: string) => void = renameSync,
): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!TRANSIENT.has(code) || attempt === RENAME_ATTEMPTS) throw error;
      sleepSynchronously(50 * attempt);
    }
  }
}

const defaultOperations: PublishOperations = {
  rename: renameWithRetry,
  remove: (path) => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
};

function readPathKind(path: string): "directory" | "file" | "other" | undefined {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function validateCompleteStage(stagingRoot: string): void {
  const missing: string[] = [];
  const wrongKind: string[] = [];
  for (const name of PUBLISH_TARGETS) {
    const actual = readPathKind(join(stagingRoot, name));
    const expected = name.endsWith(".md") || name.endsWith(".json") ? "file" : "directory";
    if (actual === undefined) {
      missing.push(name);
    } else if (actual !== expected) {
      wrongKind.push(name);
    }
  }
  if (missing.length) throw new Error(`Generation did not build required targets: ${missing.join(", ")}`);
  if (wrongKind.length) throw new Error(`Generation built targets with the wrong file type: ${wrongKind.join(", ")}`);
}

const removeIfPresent = (path: string, operations: PublishOperations): void => {
  if (readPathKind(path) !== undefined) {
    operations.remove(path);
  }
};

/**
 * Rollback collects errors instead of stopping at the first, which would leave the brain worse off than it
 * started; half-written new targets are cleared first, so a restore never lands on one.
 */
function recoverPublishedTargets(
  root: string,
  backupRoot: string,
  backedUp: readonly PublishTarget[],
  removeNewTargets: boolean,
  operations: PublishOperations,
): Error[] {
  const errors: Error[] = [];
  const attempt = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  };
  if (removeNewTargets) {
    for (const name of PUBLISH_TARGETS) {
      attempt(() => removeIfPresent(join(root, name), operations));
    }
  }
  for (const name of [...backedUp].reverse()) {
    const backup = join(backupRoot, name);
    if (readPathKind(backup) === undefined) continue;
    attempt(() => {
      removeIfPresent(join(root, name), operations);
      operations.rename(backup, join(root, name));
    });
  }
  return errors;
}

/** The pid in each path is what makes two generations in one brain directory refuse to overlap. */
function preparePublication(root: string): { brainRoot: string; stagingRoot: string; backupRoot: string } {
  const brainRoot = resolveBrainPaths(root).root;
  const stagingRoot = join(brainRoot, `.staging-${process.pid}`);
  const backupRoot = join(brainRoot, `.rollback-${process.pid}`);
  ensureDirectory(brainRoot);
  if (readPathKind(stagingRoot) !== undefined)
    throw new Error(
      `Generation staging path already exists: ${stagingRoot}. Remove it after confirming no generation is running.`,
    );
  if (readPathKind(backupRoot) !== undefined)
    throw new Error(
      `Generation rollback path already exists: ${backupRoot}. Preserve it until the prior generation is recovered.`,
    );
  mkdirSync(stagingRoot, { mode: 0o700 });
  return { brainRoot, stagingRoot, backupRoot };
}

function backUpPublishedTargets(
  brainRoot: string,
  backupRoot: string,
  movedSoFar: PublishTarget[],
  operations: PublishOperations,
): void {
  for (const name of PUBLISH_TARGETS) {
    const target = join(brainRoot, name);
    if (readPathKind(target) === undefined) continue;
    operations.rename(target, join(backupRoot, name));
    movedSoFar.push(name);
  }
}

/** Staging the whole generation first keeps the previous brain queryable through any failure. */
export async function stageThenSwap<Result>(
  root: string,
  build: (stagingRoot: string) => Result | Promise<Result>,
  operations: PublishOperations = defaultOperations,
): Promise<Result> {
  const { brainRoot, stagingRoot, backupRoot } = preparePublication(root);
  // Recovery differs by how far the swap got: no backup directory means nothing to undo; mid-move, part
  // of the old brain is still published; once it is all aside, the root holds a mixture to clear first.
  const backedUp: PublishTarget[] = [];
  let backupCreated = false;
  let backupComplete = false;
  try {
    const result = await build(stagingRoot);
    validateCompleteStage(stagingRoot);
    mkdirSync(backupRoot, { mode: 0o700 });
    backupCreated = true;
    backUpPublishedTargets(brainRoot, backupRoot, backedUp, operations);
    backupComplete = true;
    for (const name of PUBLISH_TARGETS) {
      operations.rename(join(stagingRoot, name), join(brainRoot, name));
    }
    operations.remove(backupRoot);
    backupCreated = false;
    return result;
  } catch (error) {
    const rollbackErrors = backupCreated
      ? recoverPublishedTargets(brainRoot, backupRoot, backedUp, backupComplete, operations)
      : [];
    // A rollback that could not finish keeps its backup directory: the previous brain is still in there.
    if (rollbackErrors.length)
      throw new AggregateError(
        rollbackErrors,
        `Generation failed and rollback was incomplete; backups retained at ${backupRoot}`,
        { cause: error },
      );
    if (backupCreated && readPathKind(backupRoot) !== undefined) {
      operations.remove(backupRoot);
    }
    throw error;
  } finally {
    if (readPathKind(stagingRoot) !== undefined) {
      operations.remove(stagingRoot);
    }
  }
}
