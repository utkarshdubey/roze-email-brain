// What every stage is handed instead of reaching for globals: brain paths, today's day, one metered model
// function, a progress reporter, and the worker pool. Depending on this is what lets tests drive stages.

import type { BrainPaths } from "./brain/storage.js";
import type { CallModel } from "./llm/models.js";
import type { ProgressUpdate, Ui } from "./tui.js";

export interface PipelineContext {
  paths: BrainPaths;
  callModel: CallModel;
  today: string;
  log(stage: string, done?: number, total?: number): void;
}

/** checkBudgetBeforeStage's line, so it renders through ui.cost rather than ui.info. */
const BUDGET_LINE = /expected ≈ \$/u;

/**
 * Plain messages report through ui.info (or ui.cost for a budget estimate); (stage, done, total) drives one
 * ui.progress bar per stage *per phase*, each latched once it fills so a late duplicate cannot reprint it.
 *
 * Stage names repeat: the phased build extracts, promotes and fetches threads once per phase, each time over
 * a different set. A bar is therefore retired and replaced as soon as its stage reappears with a different
 * total or with a count that has restarted — feeding a later phase's counts to an earlier phase's bar is what
 * wound `extracting`'s 54-thread bar backwards by 198 and failed a paid stage with
 * `RangeError: Invalid count value: -107`.
 */
export function createPipelineLog(ui: Ui): PipelineContext["log"] {
  const bars = new Map<string, { total: number; done: number; update: ProgressUpdate }>();
  const unrenderable = new Set<string>();
  return (stage, done, total) => {
    if (done === undefined || total === undefined) {
      if (BUDGET_LINE.test(stage)) ui.cost(stage);
      else ui.info(stage);
      return;
    }
    if (!Number.isFinite(total) || total <= 0 || unrenderable.has(stage)) return;
    // A bar is decoration drawn on top of paid work: a renderer that throws (a closed terminal, a count it
    // dislikes) must never reach the concurrency helper and abort the stage that was reporting to it. The
    // stage goes quiet for the rest of the run rather than throwing once per remaining item.
    try {
      let bar = bars.get(stage);
      if (!bar || bar.total !== total || done < bar.done) {
        bar?.update.close();
        bar = { total, done, update: ui.progress(stage, total) };
        bars.set(stage, bar);
      }
      bar.done = done;
      bar.update(done);
    } catch {
      bars.delete(stage);
      unrenderable.add(stage);
    }
  };
}

/** All scheduled work finishes, so one rejection cannot conceal failures in sibling workers. */
export async function mapAtLimitedConcurrency<Item, Result>(
  items: readonly Item[],
  limit: number,
  work: (item: Item, index: number) => Promise<Result>,
  progress: (done: number) => void = () => undefined,
): Promise<Result[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("concurrency limit must be a positive integer");
  const results: Result[] = new Array(items.length);
  const failures: Error[] = [];
  let cursor = 0;
  let done = 0;
  const runWorker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index]!;
      try {
        results[index] = await work(item, index);
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        // Enough of the failing item to find it in a log, without dumping a whole thread or card.
        const described = typeof item === "object" ? "item" : JSON.stringify(item);
        failures.push(new Error(`item ${index + 1} (${described}): ${message}`, { cause: error }));
      }
      try {
        progress(++done);
      } catch (error) {
        failures.push(new Error(`progress callback at ${done} failed`, { cause: error }));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
  if (failures.length) throw new AggregateError(failures, `${failures.length} request or progress operation(s) failed`);
  return results;
}
