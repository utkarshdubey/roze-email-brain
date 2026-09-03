// Cross-cluster collapse: the judge never knows what a sibling cluster proposed, so one effort reached
// from an organization cluster and again from a life-domain cluster arrives twice under two names. Both
// rules below keep the better-supported row — direct engagement first, then more evidence.
import { wordsFromText } from "../shared/text.js";
import { reject, type Interest, type Project, type RejectionCounts } from "../types.js";

/** Share of cited threads above which two concepts are the same thing seen twice. */
const DUPLICATE_THREAD_OVERLAP = 0.6;

const citedThreads = (row: Project | Interest): Set<string> => new Set(row.evidence.map((item) => item.threadId));
const isPassive = (row: Project | Interest): boolean => "engagement" in row && row.engagement === "passive";
const isNotDirect = (row: Project | Interest): boolean => "engagement" in row && row.engagement !== "direct";
function jaccardOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const common = [...left].filter((value) => right.has(value)).length;
  return common / (left.size + right.size - common);
}
/** Two concepts citing mostly the same threads are one concept the judge reached from two clusters. */
export function dropNearDuplicates<T extends Project | Interest>(
  rows: readonly T[],
  counts: RejectionCounts,
  kind: "project" | "interest",
): T[] {
  const ranked = [...rows].sort(
    (a, b) =>
      Number(isPassive(a)) - Number(isPassive(b)) ||
      b.evidence.length - a.evidence.length ||
      citedThreads(b).size - citedThreads(a).size,
  );
  const kept: T[] = [];
  for (const row of ranked) {
    const threads = citedThreads(row);
    const duplicate = kept.some((other) => jaccardOverlap(threads, citedThreads(other)) >= DUPLICATE_THREAD_OVERLAP);
    if (duplicate) {
      reject(counts, `${kind}_near_duplicate`);
    } else {
      kept.push(row);
    }
  }
  return kept;
}
/** One name's words wholly inside another's: "coding tools" and "AI coding tools" are not two interests. */
export function dropSubsumed<T extends Project | Interest>(
  rows: readonly T[],
  counts: RejectionCounts,
  kind: "project" | "interest",
  nameOf: (row: T) => string,
): T[] {
  const words = (row: T): Set<string> => new Set(wordsFromText(nameOf(row)));
  const ranked = [...rows].sort(
    (a, b) => Number(isNotDirect(a)) - Number(isNotDirect(b)) || b.evidence.length - a.evidence.length,
  );
  const kept: T[] = [];
  for (const row of ranked) {
    const mine = words(row);
    const subset = kept.some((other) => {
      const theirs = words(other);
      return (
        mine.size > 0 && ([...mine].every((word) => theirs.has(word)) || [...theirs].every((word) => mine.has(word)))
      );
    });
    if (subset) {
      reject(counts, kind === "project" ? "project_subsumed_name" : "interest_subsumed_topic");
    } else {
      kept.push(row);
    }
  }
  return kept;
}
