// `roze prompt <query>`: one question through the answer agent, then the answer and its counters. Both
// output modes are frozen: a rich terminal renders the Markdown and prints dim counter lines, while a
// pipe, a file, `--quiet`, or NO_COLOR/ROZE_PLAIN gets the text verbatim plus the one bracketed line.
import { parseArgs } from "node:util";

import { createTokenSource } from "../gmail/auth.js";
import { GmailClient } from "../gmail/client.js";
import { usageLedger } from "../llm/models.js";
import { answerOneQuestion } from "../query/answerAgent.js";
import type { FetchThread } from "../query/memoryTools.js";
import { readJson } from "../shared/atomicFiles.js";
import { createUi, renderMarkdown, terminalWidth } from "../tui.js";

export const PROMPT_USAGE = `Usage: roze prompt [--cap N] [--quiet] <query>

Every tool call, budget extension, and grounding check is printed as it happens; --quiet prints only the answer.
`;

export interface PromptCommandArgs {
  query: string;
  cap: number;
  quiet: boolean;
}

/** Undefined means the caller asked for help rather than a query. */
export function parsePromptCommandArguments(args: readonly string[]): PromptCommandArgs | undefined {
  const parsed = parseArgs({
    args: [...args],
    options: {
      cap: { type: "string", default: "12" },
      quiet: { type: "boolean" },
      verbose: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (parsed.values.help) return undefined;
  const cap = Number(parsed.values.cap);
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("--cap must be a positive integer.");
  const query = parsed.positionals.join(" ").trim();
  if (!query) throw new Error("Usage: roze prompt <query>");
  return { query, cap, quiet: parsed.values.quiet ?? false };
}

/** Gmail is contacted only when read_email is actually called, so a missing token never blocks answers. */
function createLiveFetch(): FetchThread | undefined {
  if (!readJson(".token.json")) return undefined;
  let client: Promise<GmailClient> | undefined;
  return async (id) => {
    client ??= Promise.resolve(new GmailClient(createTokenSource()));
    return (await client).fetchThread(id);
  };
}

/** Seconds while the answer is quick, minutes once it is not; the counter has room for one shape. */
function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function describeRounds(extensions: number, verificationRound: boolean, unverified: number): string | undefined {
  const notes = [
    extensions ? `budget extended ${extensions}×` : "",
    verificationRound ? "verification round" : "",
    unverified ? `${unverified} unverified citation${unverified > 1 ? "s" : ""}` : "",
  ].filter(Boolean);
  return notes.length ? notes.join(" · ") : undefined;
}

export async function runPromptCommand(args: PromptCommandArgs): Promise<void> {
  const ui = createUi({ quiet: args.quiet });
  const started = Date.now();
  const result = await answerOneQuestion(args.query, {
    cap: args.cap,
    verbose: !args.quiet,
    fetchThread: createLiveFetch(),
    trace: args.quiet ? undefined : (line) => ui.info(`  ${line}`),
  });
  if (!args.quiet) {
    ui.info("");
  }
  // Markdown is styled only for a human at a terminal; a pipe or a file gets the model's text verbatim.
  const styled = ui.rich && Boolean(process.stdout.isTTY);
  process.stdout.write(`${styled ? renderMarkdown(result.answer, terminalWidth()) : result.answer}\n`);
  const spend = usageLedger.total().usd;
  ui.summary({
    compact:
      `${result.toolCalls.length} tool calls · ${formatElapsed(Date.now() - started)} · ` +
      `$${spend < 0.01 ? spend.toFixed(3) : spend.toFixed(2)}`,
    detail: describeRounds(result.extensions, result.verificationRound, result.unverified.length),
    plain:
      `[${result.toolCalls.length} tool calls` +
      `${result.extensions ? `, budget extended ${result.extensions}×` : ""}] ` +
      `[${usageLedger.summaryLine()}]`,
  });
}
