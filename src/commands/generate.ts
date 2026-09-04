// `roze generate`: the flags, the help text, and the injectable seams the tests and the Enron bench use.
// The build itself lives in ../generation/buildBrain.ts.
import { parseArgs } from "node:util";

import { resolveBrainPaths } from "../brain/storage.js";
import { createPipelineLog, type PipelineContext } from "../context.js";
import { buildBrain, type GenerationMetadata } from "../generation/buildBrain.js";
import type { GenerationOptions } from "../generation/phases.js";
import { createTokenSource } from "../gmail/auth.js";
import { GmailClient, type GmailUsageSnapshot } from "../gmail/client.js";
import { DEFAULT_RECENT_MONTHS, type GmailReader } from "../ingest/mail.js";
import { cachedModelCall, resetModelState, usageLedger, type CallModel } from "../llm/models.js";
import { readCurrentCalendarDay } from "../shared/dates.js";
import { createUi } from "../tui.js";

const GENERATE_USAGE = `Usage: roze generate [options]

The brain is published in phases and is queryable after the first one:
  1. threads you took part in    2. people-first inbox skim and promoted senders
  3. complete inbox index        4. raw bodies for every other inbox thread in the window
  5. projects and interests (consolidated across clusters, loops, and receipts)

Options:
  --publish-once  Build everything first and publish a single time at the end (keeps an existing
                  complete brain queryable throughout a rebuild)
  --no-promote    Skip sender-level promotion
  --no-synthesize Skip cross-thread concept synthesis
  --no-skim       Skip the two-year header-only inbox skim
  --recent MONTHS Set the skim window in months; participated and starred mail remain all-time (default 24)
  --budget USD    Abort before a paid stage whose expected cost exceeds the remaining budget
`;

/** Test and bench seams; every field defaults to the real thing. */
export interface GenerateOverrides {
  client?: GmailReader;
  callModel?: CallModel;
  root?: string;
  write?: (text: string) => void;
  writeError?: (text: string) => void;
  today?: string;
}

function hasUsageCounters(client: GmailReader): client is GmailReader & { getUsage(): GmailUsageSnapshot } {
  return "getUsage" in client && typeof client.getUsage === "function";
}

/** Stable English grouping keeps redirected logs comparable across machine locales. */
export function formatGmailUsage(usage: GmailUsageSnapshot): string {
  const count = (value: number): string => value.toLocaleString("en-US");
  return (
    `Gmail: ${count(usage.quotaUnits)} units in ${count(usage.requests)} requests ` +
    `(threads ${count(usage.byResource.threads.requests)} · ` +
    `messages ${count(usage.byResource.messages.requests)} · ` +
    `lists ${count(usage.byResource.lists.requests)}), ${count(Math.round(usage.elapsedMs / 1_000))} s` +
    (usage.unitsPerMinute < usage.unitsPerMinuteCeiling
      ? `; Gmail granted about ${count(Math.round(usage.unitsPerMinute))} units a minute`
      : "")
  );
}

function parseGenerateOptions(args: readonly string[]): GenerationOptions & { help: boolean } {
  const parsed = parseArgs({
    args: [...args],
    options: {
      "no-promote": { type: "boolean" },
      "no-synthesize": { type: "boolean" },
      "no-skim": { type: "boolean" },
      "publish-once": { type: "boolean" },
      recent: { type: "string" },
      budget: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (parsed.positionals[0]) throw new Error(`Unexpected generate argument: ${parsed.positionals[0]}`);
  const budget = parsed.values.budget === undefined ? undefined : Number(parsed.values.budget);
  if (budget !== undefined && (!Number.isFinite(budget) || budget < 0))
    throw new Error("--budget must be a non-negative finite USD amount.");
  const recentMonths = parsed.values.recent === undefined ? DEFAULT_RECENT_MONTHS : Number(parsed.values.recent);
  if (!Number.isSafeInteger(recentMonths) || recentMonths <= 0) {
    throw new Error("--recent must be a positive integer number of months.");
  }
  return {
    noPromote: parsed.values["no-promote"] ?? false,
    noSynthesize: parsed.values["no-synthesize"] ?? false,
    noSkim: parsed.values["no-skim"] ?? false,
    publishOnce: parsed.values["publish-once"] ?? false,
    recentMonths,
    budget,
    help: parsed.values.help ?? false,
  };
}

/** Undefined when the caller asked for `--help` and nothing was built. */
export async function runGenerateCommand(
  args: readonly string[] = [],
  overrides: GenerateOverrides = {},
): Promise<GenerationMetadata | undefined> {
  const { help, ...options } = parseGenerateOptions(args);
  const write = overrides.write ?? ((text: string) => process.stdout.write(text));
  if (help) {
    write(GENERATE_USAGE);
    return undefined;
  }
  const writeError = overrides.writeError ?? ((text: string) => process.stderr.write(text));
  const ui = createUi({ write, writeError });
  const callModel: CallModel =
    overrides.callModel ?? ((request) => cachedModelCall({ ...request, budget: options.budget }));
  const client = overrides.client ?? new GmailClient(createTokenSource());
  const profile = await client.getProfile();
  const context: PipelineContext = {
    paths: resolveBrainPaths(overrides.root, profile.emailAddress),
    today: overrides.today ?? readCurrentCalendarDay(),
    callModel,
    log: createPipelineLog(ui),
  };
  resetModelState();
  ui.intro(`Generating brain for ${profile.emailAddress}`);
  const metadata = await buildBrain(client, profile, context, options, ui);
  const gmailUsage = hasUsageCounters(client) ? `\n${formatGmailUsage(client.getUsage())}` : "";
  ui.outro(
    `Brain written to ${context.paths.root}/: ${JSON.stringify(metadata.counts)}\n` +
      `API usage: ${usageLedger.summaryLine()}${gmailUsage}`,
  );
  return metadata;
}
