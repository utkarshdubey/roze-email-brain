// Audits the promoted-sender tier: what the model decided, what the guards changed, and (optionally)
// whether a stronger model agrees on a sample. Offline by default; --second-opinion N pays for N calls.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

import { resolveBrainPaths } from "../src/brain/storage.js";
import { readCachedHeaderRows } from "../src/ingest/cache.js";
import {
  groupFirstHeadersBySender,
  promotionReadSchema,
  readPromotionDecisions,
  renderSubjectWithPreview,
  type PromotionRead,
} from "../src/ingest/promote.js";
import { cachedModelCall, MODELS, usageLedger } from "../src/llm/models.js";
import { looksLikeAHuman, type MessageHeader } from "../src/types.js";
import { runAsScript, writeOut } from "./script.js";

const READS: PromotionRead[] = ["all", "recent", "latest", "ignore"];
const SECOND_OPINION = `You audit another model's decision about whether a personal-memory system should read an inbox
sender's mail in full. You see the sender, thread count, latest day, and up to three subjects with the opening
words of each message. Answer with the reading level you would choose:
- all: a real person or a small number of important messages (recruiters, landlords, offices, colleagues, friends,
  one-off admin like refunds, leases, appointments, invoices to pay).
- recent: an account or service whose recent messages carry dated commitments or money.
- latest: a recurring report or digest where one recent example captures the interest.
- ignore: marketing, promotions, job-board blasts, social notifications, automated alerts with no personal commitment.
Then say in one sentence what in the evidence decided it.`;
const opinionSchema = z.object({ read: promotionReadSchema, reason: z.string() }).strict();

interface SenderRow {
  sender: string;
  decision: PromotionRead | "undecided";
  threads: number;
  human: boolean;
  latest: string;
  sample: string;
}

function describeSender(
  sender: string,
  rows: readonly MessageHeader[],
  decision: PromotionRead | "undecided",
): SenderRow {
  const messages = [...rows].sort((a, b) => b.timestamp - a.timestamp);
  return {
    sender,
    decision,
    threads: messages.length,
    human: looksLikeAHuman(messages[0]!),
    latest: messages[0]?.day ?? "",
    sample: messages.slice(0, 3).map(renderSubjectWithPreview).join(" || "),
  };
}

/** Deterministic, so the audited sample is stable across runs and its cache reused. */
function stableSample<Item>(items: readonly Item[], size: number): Item[] {
  const scored = items.map((item, index) => ({ item, key: ((index + 1) * 2654435761) % 4294967296 }));
  return scored
    .sort((a, b) => a.key - b.key)
    .slice(0, size)
    .map((row) => row.item);
}

type SendersByDecision = Record<string, SenderRow[]>;
type Opinion = SenderRow & { second: PromotionRead; reason: string; agree: boolean };

const byThreadCount = (rows: readonly SenderRow[]): SenderRow[] =>
  [...rows].sort((a, b) => b.threads - a.threads || a.sender.localeCompare(b.sender));

function summarizeDecisions(byDecision: SendersByDecision) {
  return Object.fromEntries(
    Object.entries(byDecision).map(([read, rows]) => [
      read,
      {
        senders: rows.length,
        threads: rows.reduce((sum, row) => sum + row.threads, 0),
        humanLooking: rows.filter((row) => row.human).length,
      },
    ]),
  );
}

/** The lists worth reading by hand: where a guard fired, and where a decision looks wrong. */
function listSendersForReview(byDecision: SendersByDecision) {
  return {
    all_downgraded_to_recent_by_guard: byThreadCount(byDecision.all!.filter((row) => !row.human)).slice(0, 40),
    all_top_senders: byThreadCount(byDecision.all!).slice(0, 40),
    ignored_human_looking_senders: byThreadCount(byDecision.ignore!.filter((row) => row.human)).slice(0, 40),
    recent_top_senders: byThreadCount(byDecision.recent!).slice(0, 25),
  };
}

/** The only paid part: `size` calls spread evenly over the four decision classes. */
async function collectSecondOpinions(
  byDecision: SendersByDecision,
  size: number,
  model: string,
  cacheDir: string,
): Promise<Opinion[]> {
  if (size <= 0) return [];
  const perClass = Math.ceil(size / READS.length);
  const sample = READS.flatMap((read) => stableSample(byDecision[read]!, perClass));
  const opinions: Opinion[] = [];
  for (const row of sample) {
    const opinion = await cachedModelCall({
      kind: "promotion-audit",
      system: SECOND_OPINION,
      user: `${row.sender} | ${row.threads} threads | latest ${row.latest} | ${row.sample}`,
      schema: opinionSchema,
      model,
      effort: "low",
      cacheDir: join(cacheDir, "audit"),
    });
    opinions.push({ ...row, second: opinion.read, reason: opinion.reason, agree: opinion.read === row.decision });
  }
  return opinions;
}

function summarizeAgreement(opinions: readonly Opinion[]) {
  return Object.fromEntries(
    READS.map((read) => {
      const rows = opinions.filter((row) => row.decision === read);
      return [
        read,
        {
          sampled: rows.length,
          agree: rows.filter((row) => row.agree).length,
          second_opinion_counts: Object.fromEntries(
            READS.map((other) => [other, rows.filter((row) => row.second === other).length]),
          ),
        },
      ];
    }),
  );
}

async function auditPromotion(root: string | undefined, secondOpinion: number, model: string) {
  const paths = resolveBrainPaths(root);
  const headers = readCachedHeaderRows(paths, () => undefined, false);
  const decisions = readPromotionDecisions(paths, () => undefined);
  const grouped = groupFirstHeadersBySender(headers);
  const senders = [...grouped].map(([sender, rows]) => describeSender(sender, rows, decisions[sender] ?? "undecided"));
  const byDecision = Object.fromEntries(
    [...READS, "undecided"].map((read) => [read, senders.filter((row) => row.decision === read)]),
  ) as SendersByDecision;
  const summary = summarizeDecisions(byDecision);
  const review = listSendersForReview(byDecision);
  const opinions = await collectSecondOpinions(byDecision, secondOpinion, model, paths.cacheDir);
  const agreement = summarizeAgreement(opinions);
  return {
    generated: paths.root,
    senders: senders.length,
    headers: headers.length,
    summary,
    review,
    second_opinion: {
      model: secondOpinion > 0 ? model : null,
      agreement,
      disagreements: opinions.filter((row) => !row.agree),
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      brain: { type: "string" },
      "second-opinion": { type: "string" },
      model: { type: "string" },
      out: { type: "string" },
    },
    strict: true,
  });
  const second = values["second-opinion"] === undefined ? 0 : Number(values["second-opinion"]);
  if (!Number.isInteger(second) || second < 0) throw new Error("--second-opinion must be a non-negative integer");
  usageLedger.reset();
  const report = await auditPromotion(values.brain, second, values.model ?? MODELS.judge);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (values.out) writeOut(values.out, text);
  else process.stdout.write(text);
  process.stderr.write(`[${usageLedger.summaryLine()}]\n`);
}

runAsScript(import.meta.url, main, "Promotion audit");
