// Shared parsing for retrieval benchmarks: both harnesses must select the same gold items, truncate the
// same queries, and recognize thread ids in the same published row formats.
import { readFileSync } from "node:fs";

import { z } from "zod";

import { threadIdsInSearchHit } from "../src/query/threadIds.js";
export { threadIdsInSearchHit } from "../src/query/threadIds.js";

const expectedCitationsSchema = z
  .object({
    cite_any_of: z.array(z.string().min(1)).optional(),
  })
  .loose()
  .default({});

const exampleItemSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    expect: expectedCitationsSchema,
  })
  .loose();

const goldenSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string().min(1),
          question: z.string().min(1),
          expect: expectedCitationsSchema,
          evidence: z.array(z.object({ thread_id: z.string().min(1) }).loose()).default([]),
          expected_negative: z
            .object({
              boundary_evidence_thread_ids: z.array(z.string().min(1)).default([]),
            })
            .loose()
            .nullable()
            .optional(),
        })
        .loose(),
    ),
  })
  .loose();

export interface RetrievalItem {
  id: string;
  question: string;
  expectedThreadIds: string[];
}

const RESULT_LINE = /^([^:]+):(\d+): (.*)$/u;

export function uniqueThreadIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

export function loadRetrievalItems(file: string): RetrievalItem[] {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (Array.isArray(raw)) {
    return z
      .array(exampleItemSchema)
      .parse(raw)
      .flatMap((item) => {
        const expectedThreadIds = uniqueThreadIds(item.expect.cite_any_of ?? []);
        return expectedThreadIds.length ? [{ id: item.id, question: item.question, expectedThreadIds }] : [];
      });
  }

  return goldenSchema.parse(raw).items.flatMap((item) => {
    const expectedThreadIds = uniqueThreadIds([
      ...(item.expect.cite_any_of ?? []),
      ...item.evidence.map((row) => row.thread_id),
      ...(item.expected_negative?.boundary_evidence_thread_ids ?? []),
    ]);
    return expectedThreadIds.length ? [{ id: item.id, question: item.question, expectedThreadIds }] : [];
  });
}

export function threadIdsInResultLine(line: string): string[] {
  const result = RESULT_LINE.exec(line);
  return result ? threadIdsInSearchHit(result[1]!, result[3]!) : [];
}

/** A capped result can retain the suffix of one row without its path prefix. */
export function threadIdsInTrailingFragment(line: string): string[] {
  return threadIdsInSearchHit("", line);
}

/** Mirrors the search tool's 200-character query contract without cutting through the last word. */
export function cutRetrievalQuestion(question: string): string {
  return question.length <= 200 ? question : question.slice(0, 200).replace(/\s+\S*$/u, "");
}

export interface RetrievalDocumentFrequencies {
  documentCount: number;
  byTerm: ReadonlyMap<string, number>;
}

const RETRIEVAL_QUERY_WORD = /[\p{L}\p{M}\p{N}_]+/gu;
const RETRIEVAL_FUNCTION_WORDS = new Set([
  "about",
  "and",
  "are",
  "did",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "into",
  "that",
  "the",
  "their",
  "these",
  "this",
  "those",
  "through",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "within",
  "without",
  "you",
  "your",
]);

/** Simulated agent keywords: the three highest-IDF question terms. Frozen, because benchmarks were registered on it. */
export function computeRetrievalDocumentFrequencies(
  documents: readonly string[],
): RetrievalDocumentFrequencies {
  const byTerm = new Map<string, number>();
  for (const document of documents) {
    const terms = new Set(
      [...document.toLowerCase().matchAll(RETRIEVAL_QUERY_WORD)]
        .map((match) => match[0])
        .filter((term) => Array.from(term).length >= 3 && !/^\p{N}+$/u.test(term)),
    );
    for (const term of terms) {
      byTerm.set(term, (byTerm.get(term) ?? 0) + 1);
    }
  }
  return { documentCount: documents.length, byTerm };
}

export function selectRetrievalIdf3Terms(
  question: string,
  frequencies: RetrievalDocumentFrequencies,
): string[] {
  const seen = new Set<string>();
  const terms = [...question.toLowerCase().matchAll(RETRIEVAL_QUERY_WORD)]
    .map((match) => match[0])
    .filter((term) => {
      if (
        Array.from(term).length < 3 ||
        /^\p{N}+$/u.test(term) ||
        RETRIEVAL_FUNCTION_WORDS.has(term) ||
        seen.has(term)
      ) {
        return false;
      }
      seen.add(term);
      return true;
    });
  return terms
    .map((term, position) => ({
      term,
      position,
      idf: Math.log((frequencies.documentCount + 1) / ((frequencies.byTerm.get(term) ?? 0) + 1)),
    }))
    .sort((left, right) => right.idf - left.idf || left.position - right.position)
    .slice(0, 3)
    .map((row) => row.term);
}

/** Stable spread across the question set: every k-th item rather than the first N. */
export function splitRetrievalSpreadSample<Item>(
  items: readonly Item[],
  size: number,
): { selected: Item[]; remainder: Item[] } {
  const sample = Math.min(size, items.length);
  const step = Math.max(1, Math.floor(items.length / sample));
  const selectedIndexes = new Set(
    items
      .map((_item, index) => index)
      .filter((index) => index % step === 0)
      .slice(0, sample),
  );
  return {
    selected: items.filter((_item, index) => selectedIndexes.has(index)),
    remainder: items.filter((_item, index) => !selectedIndexes.has(index)),
  };
}
