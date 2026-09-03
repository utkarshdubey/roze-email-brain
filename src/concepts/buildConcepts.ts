// The concept layer's entry point and the order of its stages: cards → life-domain tags → entity and
// per-year domain clusters → enum-cited judge → gates → whole-list review → gates → related threads.
// This file owns the sequence, the counters in concepts.json, and the cost estimate `--budget` shows.
import { z } from "zod";
import type { PipelineContext } from "../context.js";
import { MODELS, quoteCost, readCachedModelCall, usageLedger } from "../llm/models.js";
import { cleanText, compareText, textContainsWholeName } from "../shared/text.js";
import { recurringMerchants } from "../memory/recurringMerchants.js";
import {
  mergeRejections,
  threadIncludesUser,
  type ConceptReviewLog,
  type DomainTags,
  type EmailMessage,
  type EmailThread,
  type Interest,
  type OpenLoopRow,
  type Project,
  type RejectionCounts,
  type RelatedThread,
  type ThreadCard,
  type ThreadCluster,
  type ThreadExtraction,
} from "../types.js";
import { rejectWhatTheModelGetsWrong } from "./applyGates.js";
import { buildClusters } from "./buildClusters.js";
import {
  buildClusterJudgeBatches,
  buildJudgeRequest,
  formatRowForClusterJudge,
  judgeClusters,
  MAX_JUDGE_PAYLOAD_CHARS,
  renderClusterBlock,
} from "./judgeClusters.js";
import { reviewConcepts } from "./reviewConcepts.js";
import { MAX_REVIEW_PAYLOAD_CHARS } from "./reviewRequests.js";
import { buildTagRequest, inspectCachedTags, tagLifeDomains } from "./tagLifeDomains.js";
export interface BuiltConcepts {
  projects: Project[];
  interests: Interest[];
  rejections: RejectionCounts;
  review: ConceptReviewLog;
  counts: Record<string, number>;
}
export const EMPTY_CONCEPTS: BuiltConcepts = {
  projects: [],
  interests: [],
  rejections: {},
  review: { merged: [], demoted: [], rejections: {} },
  counts: {
    durableProjects: 0,
    recurringInterests: 0,
    conceptEvidenceLinks: 0,
    conceptsRejected: 0,
    conceptSourceThreads: 0,
    conceptTaggedThreads: 0,
    conceptClusters: 0,
    conceptEntityClusters: 0,
    conceptDomainClusters: 0,
    conceptRecurringMerchants: 0,
    conceptsMergedByReview: 0,
    conceptsDemotedByReview: 0,
    conceptSynthesisApiCalls: 0,
  },
};

// THREAD CARDS — the bounded, body-free view of a thread that every later stage reads.

const MAX_SOURCE_THREADS = 12_000;
const unique = (values: Iterable<string>): string[] => [...new Set([...values].filter(Boolean))];
function cardDays(messages: readonly EmailMessage[], extraction: ThreadExtraction): string[] {
  const days = unique(messages.map((message) => message.day));
  return days.length ? days : unique(extraction.messageDays ?? []);
}
/** First and last subject only: the middle of a long thread repeats the same re: chain. */
function cardSubjects(messages: readonly EmailMessage[]): string[] {
  const subjects = unique(messages.map((message) => cleanText(message.subject, 180)).filter(Boolean));
  return subjects.length > 2 ? [subjects[0]!, subjects.at(-1)!] : subjects;
}
/** Omitting bodies limits prompt injection exposure and keeps cross-thread requests bounded. */
export function makeThreadCards(
  extractions: readonly ThreadExtraction[],
  threads: readonly EmailThread[],
  userEmail: string,
): ThreadCard[] {
  const source = new Map(threads.map((thread) => [thread.id, thread]));
  const seen = new Set<string>();
  const cards: ThreadCard[] = [];
  const user = userEmail.trim().toLowerCase();
  for (const extraction of extractions) {
    if (!extraction.threadId || seen.has(extraction.threadId)) continue;
    seen.add(extraction.threadId);
    const messages = source.get(extraction.threadId)?.messages ?? [];
    const days = cardDays(messages, extraction);
    const items: ThreadCard["items"] = extraction.items.slice(0, 8).map((row) => ({
      entity: cleanText(row.entity, 120),
      entityType: cleanText(row.entityType, 80),
      date: cleanText(row.date, 10),
      text: cleanText(row.text, 240),
      kind: row.kind,
      loopStatus: cleanText(row.loopStatus, 120),
    }));
    const participated = threadIncludesUser({ messages }, user);
    cards.push({
      threadId: extraction.threadId,
      days,
      userParticipated: participated,
      userStarted: Boolean(messages.length && messages[0]?.fromEmail.trim().toLowerCase() === user),
      subjects: cardSubjects(messages),
      summary: cleanText(extraction.summary, 500),
      state: extraction.state,
      stateNote: cleanText(extraction.stateNote, 350),
      mentions: extraction.mentions.map((row) => ({
        name: cleanText(row.name, 120),
        kind: row.kind,
        email: cleanText(row.email, 254),
        org: cleanText(row.org, 120),
        role: cleanText(row.role, 100),
      })),
      items,
      firstDay: extraction.firstDay || days[0] || "",
      lastDay: extraction.lastDay || days.at(-1) || "",
      // Engaged threads are worth clustering; substantive ones carry facts worth judging.
      engaged: participated || extraction.state !== "none" || items.some((item) => item.kind === "loop"),
      substantive: Boolean(items.length),
    });
  }
  cards.sort((a, b) => compareText(a.firstDay, b.firstDay) || compareText(a.threadId, b.threadId));
  if (cards.length > MAX_SOURCE_THREADS)
    throw new Error(
      `Cross-thread synthesis has ${cards.length.toLocaleString()} source threads; ` +
        `hard limit is ${MAX_SOURCE_THREADS.toLocaleString()}`,
    );
  return cards;
}

// RELATED THREADS — the last stage, run after the gates: literal name search, no model.

const MAX_RELATED = 15;
/** Names this short or generic match everything and are never searched on their own. */
const GENERIC = new Set([
  "university",
  "college",
  "application",
  "interview",
  "process",
  "project",
  "subscription",
  "account",
  "order",
  "team",
  "company",
  "service",
]);
interface Searchable {
  threadId: string;
  day: string;
  subject: string;
  text: string;
  participated: boolean;
}
export function indexThreadsForNameSearch(
  threads: readonly EmailThread[],
  extractions: readonly ThreadExtraction[],
  userEmail: string,
): Searchable[] {
  const byId = new Map(extractions.map((row) => [row.threadId, row]));
  return threads.flatMap((thread) => {
    const first = thread.messages[0];
    const last = thread.messages.at(-1);
    if (!first || !last) return [];
    const extraction = byId.get(thread.id);
    const parts = thread.messages.map((message) => message.subject);
    if (extraction) {
      parts.push(
        extraction.summary,
        ...extraction.mentions.map((mention) => `${mention.name} ${mention.org}`),
        ...extraction.items.map((item) => `${item.entity} ${item.text}`),
      );
    } else {
      // A body-only thread was never extracted, so raw opening text is all there is to match.
      parts.push(
        ...thread.messages.slice(0, 3).map((message) => (message.snippet || message.body).slice(0, 300)),
      );
    }
    return [
      {
        threadId: thread.id,
        day: last.day,
        subject: cleanText(first.subject, 90).trim() || "(no subject)",
        text: parts.join(" \n ").toLowerCase(),
        participated: threadIncludesUser(thread, userEmail),
      },
    ];
  });
}
export function findRelatedThreads(
  index: readonly Searchable[],
  names: readonly string[],
  cited: ReadonlySet<string>,
): RelatedThread[] {
  const needles = unique(
    names.map((name) => cleanText(name, 80)).filter((name) => name.length >= 4 && !GENERIC.has(name.toLowerCase())),
  );
  if (!needles.length) return [];
  return index
    .filter((row) => !cited.has(row.threadId) && needles.some((name) => textContainsWholeName(row.text, name)))
    .sort(
      (a, b) =>
        Number(b.participated) - Number(a.participated) ||
        b.day.localeCompare(a.day) ||
        a.threadId.localeCompare(b.threadId),
    )
    .slice(0, MAX_RELATED)
    .sort((a, b) => b.day.localeCompare(a.day) || a.threadId.localeCompare(b.threadId))
    .map(({ threadId, day, subject }) => ({ threadId, day, subject }));
}
function attachRelatedThreads(
  projects: Project[],
  interests: Interest[],
  threads: readonly EmailThread[],
  extractions: readonly ThreadExtraction[],
  userEmail: string,
): void {
  const index = indexThreadsForNameSearch(threads, extractions, userEmail);
  for (const project of projects) {
    const cited = new Set([
      ...project.evidence.map((row) => row.threadId),
      ...project.tracks.map((row) => row.threadId),
    ]);
    project.related = findRelatedThreads(index, [project.name, ...project.aliases, ...project.organizations], cited);
  }
  for (const interest of interests)
    interest.related = findRelatedThreads(
      index,
      [interest.topic],
      new Set(interest.evidence.map((row) => row.threadId)),
    );
}

// THE FLOW — every stage in order, and the counters that explain the result.

/**
 * Everything the review half needs from the judge half. The seam is where the bodies start to matter:
 * nothing above it reads a message body, so the judge can run while Gmail is still fetching them.
 */
export interface JudgedConcepts {
  cards: ThreadCard[];
  tags: DomainTags;
  clusters: ThreadCluster[];
  /** The thread ids the clusters covered; the gates refuse citations outside it. */
  scope: Set<string>;
  rejections: RejectionCounts;
  projects: Project[];
  interests: Interest[];
  /** The ledger's call count when synthesis started, so conceptSynthesisApiCalls stays synthesis-only. */
  callsBefore: number;
}

/** Cards → tags → clusters → judge → gates: the model-only half, which needs no message body. */
export async function judgeConceptCandidates(
  extractions: readonly ThreadExtraction[],
  threads: readonly EmailThread[],
  userEmail: string,
  context: PipelineContext,
): Promise<JudgedConcepts> {
  const callsBefore = usageLedger.total().calls;
  const cards = makeThreadCards(extractions, threads, userEmail);
  const tags = await tagLifeDomains(cards, userEmail, context);
  const clusters = buildClusters(cards, tags);
  const judged = await judgeClusters(clusters, cards, tags, userEmail, context);
  const rejections: RejectionCounts = { ...judged.rejections };
  // The judge only ever saw clustered threads, so that is the scope its citations are checked against.
  const scope = new Set(clusters.flatMap((cluster) => cluster.threadIds));
  const gated = rejectWhatTheModelGetsWrong(
    { projects: judged.projects },
    { interests: judged.interests },
    threads,
    extractions,
    scope,
    userEmail,
  );
  mergeRejections(rejections, gated.rejections);
  const { projects, interests } = gated;
  return { cards, tags, clusters, scope, rejections, projects, interests, callsBefore };
}

/**
 * Review → gates → related threads: the half that needs every stored body, both for the recurring
 * merchants the review consolidates against and for the citations the final gates check. `bodies`
 * (fetched, never extracted) and `loops` are deterministic context the review may cite beside the
 * clusters' own threads, and the reason concepts finish last.
 */
export async function reviewAndFinishConcepts(
  judged: JudgedConcepts,
  extractions: readonly ThreadExtraction[],
  threads: readonly EmailThread[],
  userEmail: string,
  context: PipelineContext,
  sources: { bodies: readonly EmailThread[]; loops: readonly OpenLoopRow[] },
): Promise<BuiltConcepts> {
  const { cards, tags, clusters, scope, callsBefore } = judged;
  const { bodies, loops } = sources;
  const rejections: RejectionCounts = { ...judged.rejections };
  const merchants = recurringMerchants([...threads, ...bodies]);
  const reviewed = await reviewConcepts(judged.projects, judged.interests, loops, merchants, userEmail, context);
  mergeRejections(rejections, reviewed.log.rejections);
  // The review could also cite loops and merchant receipts, so the scope widens by exactly those.
  const reviewScope = new Set([...scope, ...reviewed.extraThreadIds]);
  const everyThread = [...threads, ...bodies];
  const final = rejectWhatTheModelGetsWrong(
    { projects: reviewed.projects },
    { interests: reviewed.interests },
    everyThread,
    extractions,
    reviewScope,
    userEmail,
  );
  mergeRejections(rejections, final.rejections);
  attachRelatedThreads(final.projects, final.interests, everyThread, extractions, userEmail);
  return {
    projects: final.projects,
    interests: final.interests,
    rejections: Object.fromEntries(
      Object.entries(rejections)
        .filter(([, value]) => value > 0)
        .sort(),
    ),
    review: reviewed.log,
    counts: {
      durableProjects: final.projects.length,
      recurringInterests: final.interests.length,
      conceptEvidenceLinks: [...final.projects, ...final.interests].reduce((sum, row) => sum + row.evidence.length, 0),
      conceptsRejected: Object.values(rejections).reduce((sum, value) => sum + value, 0),
      conceptSourceThreads: cards.length,
      conceptTaggedThreads: Object.values(tags).filter((tag) => tag.domains.length).length,
      conceptClusters: clusters.length,
      conceptEntityClusters: clusters.filter((cluster) => cluster.kind === "entity").length,
      conceptDomainClusters: clusters.filter((cluster) => cluster.kind === "domain").length,
      conceptRecurringMerchants: merchants.length,
      conceptsMergedByReview: reviewed.log.merged.length,
      conceptsDemotedByReview: reviewed.log.demoted.length,
      conceptSynthesisApiCalls: usageLedger.total().calls - callsBefore,
    },
  };
}

/** The whole flow in one call, for the concept rebuild bench and for tests; generate overlaps the halves. */
export async function buildConcepts(
  extractions: readonly ThreadExtraction[],
  threads: readonly EmailThread[],
  userEmail: string,
  context: PipelineContext,
  bodies: readonly EmailThread[],
  loops: readonly OpenLoopRow[],
): Promise<BuiltConcepts> {
  const judged = await judgeConceptCandidates(extractions, threads, userEmail, context);
  return reviewAndFinishConcepts(judged, extractions, threads, userEmail, context, { bodies, loops });
}

// COST ESTIMATE — what `--budget` shows before any of the above is allowed to spend.

const CHARS_PER_TOKEN = 3;
const requestChars = (request: { system: string; user: string; schema: z.ZodType }): number =>
  request.system.length +
  request.user.length +
  JSON.stringify(z.toJSONSchema(request.schema, { target: "draft-07", io: "input" })).length;
const tokensFrom = (charCounts: readonly number[]): number =>
  Math.ceil(charCounts.reduce((sum, chars) => sum + chars / CHARS_PER_TOKEN, 0));
/** With tags cached the clusters exist, so every uncached judge batch can be priced exactly. */
function judgeCharsForKnownClusters(
  cards: readonly ThreadCard[],
  tags: DomainTags,
  userEmail: string,
  context: PipelineContext,
): number[] {
  const clusters = buildClusters(cards, tags);
  return buildClusterJudgeBatches(clusters, cards, tags).flatMap((batch) => {
    const { request } = buildJudgeRequest(
      batch,
      cards,
      tags,
      userEmail,
      context.today,
      context.paths.cachedConceptsDir,
    );
    return readCachedModelCall(request) === undefined ? [requestChars(request)] : [];
  });
}
/** No tags yet: entity blocks plus three plausible domain placements per useful card. */
function projectedJudgeChars(cards: readonly ThreadCard[]): number[] {
  const byId = new Map(cards.map((card) => [card.threadId, card]));
  const entityChars = buildClusters(cards, {}).reduce(
    (sum, cluster) => sum + renderClusterBlock(cluster, byId, {}).length,
    0,
  );
  const useful = cards.filter((card) => card.engaged || card.substantive);
  const average = useful.length
    ? useful.reduce((sum, card) => sum + JSON.stringify(formatRowForClusterJudge(card, "")).length, 0) / useful.length
    : 0;
  const calls = Math.ceil((entityChars + useful.length * 3 * average) / MAX_JUDGE_PAYLOAD_CHARS);
  return Array.from({ length: calls }, () => MAX_JUDGE_PAYLOAD_CHARS);
}
// A planning estimate only: actual spend is enforced separately by the usage ledger.
export function estimateConceptCost(
  extractions: readonly ThreadExtraction[],
  threads: readonly EmailThread[],
  userEmail: string,
  context: PipelineContext,
) {
  const cards = makeThreadCards(extractions, threads, userEmail);
  const cached = inspectCachedTags(cards, userEmail, context);
  const tagInputs = cached.uncached.map((batch) => requestChars(buildTagRequest(batch, userEmail)));
  const judgeInputs = cached.uncached.length
    ? projectedJudgeChars(cards)
    : judgeCharsForKnownClusters(cards, cached.tags, userEmail, context);
  // The review depends on what the judge accepts, so it is budgeted at two full-size calls.
  const reviewInput = Math.ceil((2 * MAX_REVIEW_PAYLOAD_CHARS) / CHARS_PER_TOKEN);
  const tagInput = tokensFrom(tagInputs);
  const judgeInput = tokensFrom(judgeInputs) + reviewInput;
  // Output tokens a tag batch, a judge batch, and the whole review pass are budgeted at.
  const tagOutput = cached.uncached.length * 1_200;
  const judgeOutput = judgeInputs.length * 2_500 + 12_000;
  const tagCost = quoteCost(MODELS.tag, tagInput, tagOutput);
  const judgeCost = quoteCost(MODELS.judge, judgeInput, judgeOutput);
  const usd = tagCost === null || judgeCost === null ? null : tagCost + judgeCost;
  return {
    calls: cached.uncached.length + judgeInputs.length + 2,
    items: cards.length,
    inputTokens: tagInput + judgeInput,
    outputTokens: tagOutput + judgeOutput,
    usd,
    model: `${MODELS.tag} (tags) + ${MODELS.judge} (judge, review)`,
  };
}
