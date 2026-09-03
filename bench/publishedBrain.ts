// A published brain's cached sources: raw threads, the extractions already paid for, and the body-only
// threads that were never extracted. Offline by design.
import { readdirSync } from "node:fs";
import { z } from "zod";

import type { BrainPaths } from "../src/brain/storage.js";
import { readCachedThread } from "../src/ingest/cache.js";
import type { PipelineContext } from "../src/context.js";
import { readCachedExtraction } from "../src/memory/extractThread.js";
import { localizeThread, type OffsetTimeline } from "../src/shared/dates.js";
import type { EmailThread, ThreadExtraction } from "../src/types.js";

export const brainMetaSchema = z.object({ userEmail: z.string().min(1), generatedAt: z.string().min(1) }).loose();

interface CachedBrain {
  everyThread: EmailThread[];
  /** The threads an extraction was cached for; `bodies` is the rest, cited as raw evidence only. */
  threads: EmailThread[];
  bodies: EmailThread[];
  extractions: ThreadExtraction[];
}

/** `only` restricts the extracted set to the ids the brain published, ignored when empty. */
export async function loadCachedBrain(
  paths: BrainPaths,
  timezone: OffsetTimeline,
  userEmail: string,
  context: PipelineContext,
  only?: ReadonlySet<string>,
): Promise<CachedBrain> {
  const ids = readdirSync(paths.evidenceThreadsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.slice(0, -3))
    .sort();
  const everyThread = ids.map((id) => {
    const thread = readCachedThread(id, paths);
    if (!thread) throw new Error(`Invalid cached thread: ${id}`);
    return localizeThread(thread, timezone);
  });
  const pairs = everyThread
    .filter((thread) => !only?.size || only.has(thread.id))
    .flatMap((thread) => {
      const extraction = readCachedExtraction(thread, userEmail, context);
      return extraction ? [{ thread, extraction }] : [];
    });
  const threads = pairs.map((row) => row.thread);
  const extracted = new Set(threads.map((thread) => thread.id));
  return {
    everyThread,
    threads,
    bodies: everyThread.filter((thread) => !extracted.has(thread.id)),
    extractions: pairs.map((row) => row.extraction),
  };
}
