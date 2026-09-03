// The one model stage inside ingestion: a batch of sender lines goes to the mini model, which answers all
// / recent / latest / ignore, and local limits turn those answers into thread ids for the next fetch.

import { z } from "zod";
import type { BrainPaths } from "../brain/storage.js";
import { mapAtLimitedConcurrency, type PipelineContext } from "../context.js";
import { MODELS, quoteCost } from "../llm/models.js";
import { readJson, writeDataAtomically } from "../shared/atomicFiles.js";
import { looksLikeAHuman, type MessageHeader } from "../types.js";

export const promotionReadSchema = z.enum(["all", "recent", "latest", "ignore"]);
export type PromotionRead = z.infer<typeof promotionReadSchema>;
type PromotionDecisions = Record<string, PromotionRead>;
const decisionsSchema = z.record(z.string().min(1), promotionReadSchema);

const BATCH_SIZE = 120;
const PROMOTION_WORKERS = 4;
/** Local caps on what each verdict may promote, newest first. */
const ALL_THREADS = 25;
const RECENT_THREADS = 5;
const RECENT_WINDOW_SECONDS = 180 * 86_400;

export function readPromotionDecisions(paths: BrainPaths, warn: (message: string) => void): PromotionDecisions {
  const value = readJson(paths.cachedPromotionFile);
  if (value === undefined) return {};
  const parsed = decisionsSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  warn("  warning: ignoring malformed promotion cache");
  return {};
}

/** Codes and login alerts carry no memory, but are dropped per message so a bank keeps its real notices. */
const SECURITY_NOISE = new RegExp(
  String.raw`\b(verification code|one-time (code|passcode|password)|security code|sign-in (code|attempt)|` +
    String.raw`login (code|alert|attempt)|new (sign-in|login|device)|authenticate your email|` +
    String.raw`confirm your email( address)?|verify your (email|account|identity)|password reset|` +
    String.raw`reset your password|two-factor|2-step|2fa|otp)\b`,
  "iu",
);

const promotionResponseSchema = z
  .object({ decisions: z.array(z.object({ sender: z.string(), read: promotionReadSchema }).strict()) })
  .strict();

const PROMOTE_SYSTEM = `You decide which inbox senders are worth reading in full for a personal memory that tracks the
user's people, projects, interests, and open loops. You only see the sender, how many threads they sent, and a
few subjects with the opening words of each message. Every subject stays searchable and any single message can
be fetched on demand later, so ignoring a sender loses nothing except automatic extraction. When in doubt,
ignore. For each sender answer:
- all: a real person writing to the user, or a small number of messages with personal stakes (recruiters
  about a specific role, landlords, school/immigration offices, colleagues, friends, one-off admin such as
  refunds, leases, appointments, invoices to pay, application decisions).
- recent: an account or service whose messages carry money the user paid or owes, or dated obligations
  (statements, receipts, subscriptions and trials, orders and deliveries, tickets, government or bank
  actions, security alerts about the user's own account). Only the latest few are read.
- latest: a recurring report about the user's own accounts or projects (analytics, usage, monitoring, monthly
  statements) where one recent example captures the interest.
- ignore: editorial newsletters, product and feature announcements, community and event invitations,
  conference and course marketing, cart and offer nudges, terms or policy updates, price alerts, social
  recaps, job-board blasts, and anything a business sends to everyone. A recognisable brand does not make
  mail important; a personal stake does.
Return a decision for every sender listed.`;

interface PromotionWork {
  senders: string[];
  payload: string;
}

export function renderSubjectWithPreview(row: MessageHeader): string {
  const preview = (row.snippet ?? "").replace(/\s+/gu, " ").trim().slice(0, 90);
  return preview ? `${row.subject.slice(0, 60)} — ${preview}` : row.subject.slice(0, 60);
}

/** One row per thread, filed under its opening sender; verification codes never reach the model. */
export function groupFirstHeadersBySender(rows: readonly MessageHeader[]): Map<string, MessageHeader[]> {
  const first = new Map<string, MessageHeader>();
  for (const row of rows) {
    const prior = first.get(row.threadId);
    if (!prior || row.timestamp < prior.timestamp) {
      first.set(row.threadId, row);
    }
  }
  const grouped = new Map<string, MessageHeader[]>();
  for (const row of first.values()) {
    if (SECURITY_NOISE.test(row.subject)) continue;
    const sender = grouped.get(row.fromEmail);
    if (sender) {
      sender.push(row);
    } else {
      grouped.set(row.fromEmail, [row]);
    }
  }
  return grouped;
}

const newestFirst = (rows: readonly MessageHeader[]): MessageHeader[] =>
  [...rows].sort((a, b) => b.timestamp - a.timestamp);

function renderSenderLine(sender: string, messages: readonly MessageHeader[]): string {
  const rows = newestFirst(messages);
  return (
    `${sender} | ${rows.length} threads | latest ${rows[0]?.day ?? ""} | ` +
    rows.slice(0, 3).map(renderSubjectWithPreview).join(" || ")
  );
}

function planPromotion(
  rows: readonly MessageHeader[],
  decisions: PromotionDecisions,
): { grouped: Map<string, MessageHeader[]>; work: PromotionWork[]; senders: number } {
  const grouped = groupFirstHeadersBySender(rows);
  const todo = [...grouped]
    .filter(([sender]) => decisions[sender] === undefined)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([sender]) => sender);
  const work: PromotionWork[] = [];
  for (let start = 0; start < todo.length; start += BATCH_SIZE) {
    const senders = todo.slice(start, start + BATCH_SIZE);
    const payload = senders.map((sender) => renderSenderLine(sender, grouped.get(sender)!)).join("\n");
    work.push({ senders, payload });
  }
  return { grouped, work, senders: todo.length };
}

export function estimatePromotionCost(rows: readonly MessageHeader[], context: PipelineContext) {
  const decisions = readPromotionDecisions(context.paths, (message) => context.log(message));
  const { work, senders } = planPromotion(rows, decisions);
  const inputTokens = Math.trunc(
    work.reduce((sum, batch) => sum + (PROMOTE_SYSTEM.length + batch.payload.length) / 4, 0),
  );
  const outputTokens = work.reduce((sum, batch) => sum + Math.max(8, batch.senders.length * 12), 0);
  return {
    calls: work.length,
    items: senders,
    inputTokens,
    outputTokens,
    usd: quoteCost(MODELS.promote, inputTokens, outputTokens),
    model: MODELS.promote,
  };
}

function threadsEarnedBy(decision: PromotionRead, rows: readonly MessageHeader[]): MessageHeader[] {
  const newest = rows[0];
  if (!newest) return [];
  if (decision === "all") return rows.slice(0, ALL_THREADS);
  if (decision === "recent") {
    // Relative recency preserves coherent histories even when a sender has been quiet for years.
    const cutoff = newest.timestamp - RECENT_WINDOW_SECONDS;
    return rows.slice(0, RECENT_THREADS).filter((row) => row.timestamp >= cutoff);
  }
  if (decision === "latest") return [newest];
  return [];
}

function choosePromotedThreads(grouped: ReadonlyMap<string, MessageHeader[]>, decisions: PromotionDecisions): string[] {
  const promoted: string[] = [];
  for (const [sender, source] of grouped) {
    const rows = newestFirst(source);
    const newest = rows[0];
    if (!newest) continue;
    let decision = decisions[sender] ?? "ignore";
    // An automated sender never earns its whole history, however convincing its subjects looked.
    if (decision === "all" && !looksLikeAHuman(newest)) {
      decision = "recent";
    }
    promoted.push(...threadsEarnedBy(decision, rows).map((row) => row.threadId));
  }
  return [...new Set(promoted)];
}

/** The decision file accumulates across runs; each batch response is also in the shared model cache. */
export async function decideWhatToReadPerSender(
  rows: readonly MessageHeader[],
  context: PipelineContext,
): Promise<string[]> {
  const decisions = readPromotionDecisions(context.paths, (message) => context.log(message));
  const { grouped, work, senders: total } = planPromotion(rows, decisions);
  let done = 0;
  await mapAtLimitedConcurrency(work, PROMOTION_WORKERS, async (batch) => {
    const response = await context.callModel({
      kind: "promotion",
      system: PROMOTE_SYSTEM,
      user: batch.payload,
      schema: promotionResponseSchema,
      model: MODELS.promote,
      effort: "minimal",
      cacheDir: context.paths.cacheDir,
    });
    const returned = new Map(response.decisions.map((row) => [row.sender, row.read]));
    // A sender the model left out of its answer is ignored rather than retried.
    for (const sender of batch.senders) {
      decisions[sender] = returned.get(sender) ?? "ignore";
    }
    writeDataAtomically(context.paths.cachedPromotionFile, decisionsSchema.parse(decisions));
    context.log("promoting", (done += batch.senders.length), total);
  });
  return choosePromotedThreads(grouped, decisions);
}
