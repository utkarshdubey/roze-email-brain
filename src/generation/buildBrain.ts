// The generation orchestration: Gmail in, a published brain out, one phase at a time.
//
//   full-read → fast-inbox → complete-inbox → body-evidence → concepts
//
// `BrainBuild` accumulates the stage outputs and, at the end of every enabled phase, renders the whole
// tree from whatever it has so far and swaps it into place atomically — which is why each phase leaves a
// queryable brain behind and why `--publish-once` can skip the intermediate swaps without changing any of
// the work or its order. Every paid stage is cost-checked against `--budget` first. Gmail-bound work and
// model-bound work overlap wherever nothing depends on both: the fast header skim runs beside the first
// extraction, and the body fetch beside the concept judge.
import { join } from "node:path";

import { writeConceptFiles } from "../brain/renderConcepts.js";
import { writeEntityFiles } from "../brain/renderEntities.js";
import { writeEvidenceFiles } from "../brain/renderEvidence.js";
import { writeRootIndex } from "../brain/renderRootIndex.js";
import { writeThreadSummaries } from "../brain/renderThreadSummaries.js";
import { stageThenSwap } from "../brain/storage.js";
import {
  EMPTY_CONCEPTS,
  estimateConceptCost,
  judgeConceptCandidates,
  reviewAndFinishConcepts,
  type BuiltConcepts,
  type JudgedConcepts,
} from "../concepts/buildConcepts.js";
import type { PipelineContext } from "../context.js";
import type { GmailProfile } from "../gmail/client.js";
import { readCachedHeaderRows } from "../ingest/cache.js";
import {
  fetchRecentInboxHeaders,
  fetchThreadsById,
  listParticipatedThreadIds,
  sortThreads,
  type GmailReader,
} from "../ingest/mail.js";
import { decideWhatToReadPerSender, estimatePromotionCost } from "../ingest/promote.js";
import { checkBudgetBeforeStage } from "../llm/models.js";
import { estimateExtractionCost, extractMemoryFromAllThreads } from "../memory/extractThread.js";
import { listOpenLoops } from "../memory/openLoops.js";
import { EntityRegistry } from "../memory/resolveEntities.js";
import { writeDataAtomically } from "../shared/atomicFiles.js";
import { buildOffsetTimeline, localizeHeader, localizeThread, type OffsetTimeline } from "../shared/dates.js";
import type { Ui } from "../tui.js";
import { threadIncludesUser, type EmailThread, type MessageHeader, type ThreadExtraction } from "../types.js";
import { buildStatus, planPhases, type BuildStatus, type GenerationOptions, type Phase } from "./phases.js";

export interface GenerationMetadata {
  userEmail: string;
  historyId: string;
  generatedAt: string;
  /** When the user's offset changed, from their sent mail; every day is rendered by it. */
  timezone: OffsetTimeline;
  build: BuildStatus;
  counts: Record<string, number>;
}

/** A background fetch must never surface as an unhandled rejection while another phase runs. */
const settle = <Value>(task: Promise<Value>): Promise<{ value: Value } | { error: unknown }> =>
  task.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

class BrainBuild {
  private readonly plan: Phase[];
  private readonly started = Date.now();
  private readonly userEmail: string;

  private threads: EmailThread[] = [];
  private skim: MessageHeader[] = [];
  private promoted: string[] = [];
  private bodies: EmailThread[] = [];
  private extractions: ThreadExtraction[] = [];
  private concepts: BuiltConcepts = EMPTY_CONCEPTS;
  private timezone: OffsetTimeline = [];
  private published: GenerationMetadata | undefined;
  /** Started in the full-read phase, awaited by the inbox phases; undefined under `--no-skim`. */
  private fastHeaders: Promise<{ value: MessageHeader[] } | { error: unknown }> | undefined;
  /** Started by the inbox phases, awaited beside the judge; undefined under `--no-skim`. */
  private bodyTask: Promise<{ value: EmailThread[] } | { error: unknown }> | undefined;
  private bodyIds: string[] = [];

  constructor(
    private readonly client: GmailReader,
    private readonly profile: GmailProfile,
    private readonly context: PipelineContext,
    private readonly options: GenerationOptions,
    private readonly ui: Ui,
  ) {
    this.plan = planPhases(options);
    this.userEmail = profile.emailAddress;
  }

  async run(): Promise<GenerationMetadata> {
    await this.runFullReadPhase();
    await this.runInboxPhases();
    await this.runBodyAndConceptPhases();
    if (!this.published) throw new Error("Unreachable: the final phase always publishes");
    return this.published;
  }

  private registry(): EntityRegistry {
    const participated = this.threads.filter((thread) => threadIncludesUser(thread, this.userEmail));
    return EntityRegistry.fromExtractions(
      this.extractions,
      this.userEmail,
      new Set(participated.map((thread) => thread.id)),
    );
  }

  private renderInto(root: string, build: BuildStatus): GenerationMetadata {
    const evidence = writeEvidenceFiles(this.threads, this.skim, this.userEmail, root, this.bodies);
    const summaries = writeThreadSummaries(this.extractions, root, this.context.today);
    const entities = writeEntityFiles(this.registry(), root, this.context.today);
    const { projects, interests, rejections, review } = this.concepts;
    writeConceptFiles(projects, interests, rejections, root, review);
    writeRootIndex(
      this.userEmail,
      evidence,
      root,
      this.context.today,
      [
        `- people/INDEX.md — ${entities.entities} people and organizations with dated, cited facts ` +
          "(organizations/INDEX.md holds the organizations).",
        `- projects/INDEX.md — ${projects.length} durable, outcome-oriented efforts across threads.`,
        `- interests/INDEX.md — ${interests.length} recurring interests, pursued vs receipts-only.`,
        `- open_loops/INDEX.md — ${entities.openLoops} unresolved commitments and pending items, newest first.`,
        "- evidence/inbox-<year>.md — every other inbox thread of the last two years; rows marked body " +
          "have raw messages in evidence/threads/<id>.md, rows marked header need read_email.",
      ],
      build.complete
        ? "Build status: complete."
        : `Build status: phase ${build.phase} of ${build.phases}, generate is still running. ` +
            `Not yet available: ${build.pending.join("; ")}. Say so when a question depends on them.`,
    );
    const metadata: GenerationMetadata = {
      userEmail: this.userEmail,
      historyId: this.profile.historyId,
      generatedAt: this.context.today,
      timezone: this.timezone,
      build,
      counts: {
        threads: evidence.threads,
        messages: evidence.messages,
        skimThreads: evidence.skimThreads,
        bodyThreads: evidence.bodyThreads,
        transactions: evidence.transactions,
        promoted: this.promoted.length,
        ...summaries,
        ...entities,
        ...this.concepts.counts,
      },
    };
    writeDataAtomically(join(root, "meta.json"), metadata);
    return metadata;
  }

  /** Each phase renders a complete tree before the atomic swap. */
  private async publishPhase(phase: Phase, summary: string): Promise<void> {
    const build = buildStatus(this.plan, phase);
    const elapsed = `${Math.round((Date.now() - this.started) / 1_000)}s`;
    if (this.options.publishOnce && !build.complete) {
      this.ui.step(
        `Phase ${build.phase}/${build.phases} ready after ${elapsed} (publishing once at the end): ${summary}`,
      );
      return;
    }
    this.published = await stageThenSwap(this.context.paths.root, async (root) => this.renderInto(root, build));
    const where = build.phase === 1 ? ` to ${this.context.paths.root}` : "";
    const hint = build.complete ? "" : " `roze prompt` works now from another terminal while this keeps building.";
    this.ui.step(`Phase ${build.phase}/${build.phases} published after ${elapsed}${where}: ${summary}${hint}`);
  }

  private async extract(source: readonly EmailThread[]): Promise<void> {
    const { context, options, userEmail } = this;
    checkBudgetBeforeStage("extraction", estimateExtractionCost(source, userEmail, context), options.budget, context);
    this.extractions.push(...(await extractMemoryFromAllThreads(source, userEmail, context)));
  }

  /** Runs on every cached header row; only threads not already read in full are fetched. */
  private async promote(): Promise<EmailThread[]> {
    if (this.options.noPromote) return [];
    const { context, options } = this;
    const headers = readCachedHeaderRows(context.paths, (message) => context.log(message));
    checkBudgetBeforeStage("promotion", estimatePromotionCost(headers, context), options.budget, context);
    this.promoted = await decideWhatToReadPerSender(headers, context);
    const known = new Set(this.threads.map((thread) => thread.id));
    const wanted = this.promoted.filter((id) => !known.has(id));
    const fetched = await fetchThreadsById(this.client, wanted, context, "promoted");
    const fresh = fetched
      .filter((thread) => thread.messages.length)
      .map((thread) => localizeThread(thread, this.timezone));
    this.threads = sortThreads([...this.threads, ...fresh]);
    await this.extract(fresh);
    return fresh;
  }

  /** Every thread the user sent in, starred, or previously pulled on demand. */
  private async runFullReadPhase(): Promise<void> {
    // The fast inbox scan is Gmail-bound and the first extraction is model-bound, so they overlap.
    this.fastHeaders = this.options.noSkim
      ? undefined
      : settle(fetchRecentInboxHeaders(this.client, this.context, "fast"));
    const ids = await listParticipatedThreadIds(this.client, this.context);
    const fetched = await fetchThreadsById(this.client, ids, this.context, "threads");
    const raw = fetched.filter((thread) => thread.messages.length);
    this.timezone = buildOffsetTimeline(raw, this.userEmail);
    this.threads = raw.map((thread) => localizeThread(thread, this.timezone));
    const latest = this.timezone.at(-1)?.[1] ?? 0;
    this.context.log(
      `  ${this.threads.length} threads you took part in (days rendered in your timezone, currently ` +
        `UTC${latest >= 0 ? "+" : "-"}${Math.abs(latest) / 60}; ${this.timezone.length} offset change(s) seen)`,
    );
    await this.extract(this.threads);
    await this.publishPhase("full-read", `${this.threads.length} threads you took part in.`);
  }

  /** The inbox tiers: a fast header sample, then the complete index, which starts the body fetch. */
  private async runInboxPhases(): Promise<void> {
    if (!this.fastHeaders) return;
    const result = await this.fastHeaders;
    if ("error" in result) throw result.error;
    this.skim = result.value.map((row) => localizeHeader(row, this.timezone));
    let fresh = await this.promote();
    await this.publishPhase(
      "fast-inbox",
      `${result.value.length} skim-tier threads, ${fresh.length} promoted threads read in full.`,
    );

    const complete = await fetchRecentInboxHeaders(this.client, this.context, "complete");
    this.skim = complete.map((row) => localizeHeader(row, this.timezone));
    fresh = await this.promote();
    await this.publishPhase(
      "complete-inbox",
      `${this.skim.length} skim-tier threads indexed, ${fresh.length} more promoted threads read in full.`,
    );

    // Bodies are Gmail-only; the backfill already cached most of them, so only unread skim threads cost.
    const known = new Set(this.threads.map((thread) => thread.id));
    this.bodyIds = [...new Set(this.skim.map((row) => row.threadId))].filter((id) => !known.has(id));
    this.bodyTask = settle(
      fetchThreadsById(this.client, this.bodyIds, this.context, "bodies").then((fetched) =>
        fetched.map((thread) => localizeThread(thread, this.timezone)),
      ),
    );
  }

  /**
   * The budget check is the task's first statement, so it still runs before the first paid concept call.
   */
  private startJudge(): Promise<{ value: JudgedConcepts } | { error: unknown }> | undefined {
    if (this.options.noSynthesize) return undefined;
    const { context, extractions, options, threads, userEmail } = this;
    return settle(
      (async () => {
        const estimate = estimateConceptCost(extractions, threads, userEmail, context);
        checkBudgetBeforeStage("synthesis", estimate, options.budget, context);
        return judgeConceptCandidates(extractions, threads, userEmail, context);
      })(),
    );
  }

  /**
   * The bodies are Gmail-bound and the judge is model-bound, so they overlap; only the review that follows
   * needs the recurring merchants parsed from every stored body, which is why concepts still finish last.
   */
  private async runBodyAndConceptPhases(): Promise<void> {
    const judgeTask = this.startJudge();
    // Both are awaited before either failure is raised, so neither can end as an unhandled rejection.
    const bodyResult = this.bodyTask ? await this.bodyTask : undefined;
    const judgeResult = judgeTask ? await judgeTask : undefined;
    if (bodyResult) {
      if ("error" in bodyResult) throw bodyResult.error;
      this.bodies = bodyResult.value;
      await this.publishPhase(
        "body-evidence",
        `raw bodies stored for ${this.bodies.length} of ${this.bodyIds.length} remaining inbox threads` +
          `${judgeTask ? ", concepts judged alongside" : ""}.`,
      );
    }
    if (judgeResult) {
      if ("error" in judgeResult) throw judgeResult.error;
      const { context, extractions, threads, userEmail } = this;
      const loops = listOpenLoops(this.registry().listEntities(), context.today);
      this.concepts = await reviewAndFinishConcepts(judgeResult.value, extractions, threads, userEmail, context, {
        bodies: this.bodies,
        loops,
      });
      await this.publishPhase(
        "concepts",
        `${this.concepts.projects.length} projects, ${this.concepts.interests.length} interests.`,
      );
    }
  }
}

export async function buildBrain(
  client: GmailReader,
  profile: GmailProfile,
  context: PipelineContext,
  options: GenerationOptions,
  ui: Ui,
): Promise<GenerationMetadata> {
  return new BrainBuild(client, profile, context, options, ui).run();
}
