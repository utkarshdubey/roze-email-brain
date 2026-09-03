// The program entry point: parse the first positional, hand the rest to one of the three commands in
// ./commands/, and turn whatever escapes into a single readable stderr message.
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { runAuthCommand } from "./commands/auth.js";
import { runGenerateCommand } from "./commands/generate.js";
import { parsePromptCommandArguments, runPromptCommand, PROMPT_USAGE } from "./commands/prompt.js";
import { createUi } from "./tui.js";

const USAGE = `Usage: roze <command> [options]

Turn your Gmail into a queryable personal memory.

Commands:
  auth      Sign in with Google (Gmail read-only)
  generate  Read your email history and build the brain
  prompt    Ask the brain a single question
`;

/** Aggregate and wrapped errors print their causes, so a failed request names the request. */
function describeError(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error);
  const lines = [error.message];
  if (error instanceof AggregateError)
    lines.push(...error.errors.slice(0, 5).map((inner) => `  - ${describeError(inner, depth + 1)}`));
  if (error.cause !== undefined && depth < 3) {
    lines.push(`  caused by: ${describeError(error.cause, depth + 1)}`);
  }
  return lines.join("\n");
}

async function dispatch(command: string | undefined, commandArgs: string[]): Promise<void> {
  if (command === "auth") {
    await runAuthCommand(commandArgs);
    return;
  }
  if (command === "generate") {
    await runGenerateCommand(commandArgs);
    return;
  }
  if (command === "prompt") {
    const promptArgs = parsePromptCommandArguments(commandArgs);
    if (promptArgs) await runPromptCommand(promptArgs);
    else process.stdout.write(PROMPT_USAGE);
    return;
  }
  process.stdout.write(USAGE);
  throw new Error(`Unknown command: ${command ?? ""}`);
}

/** A temporary owner-only umask protects tokens and generated mail without changing the parent shell. */
export async function main(argv: string[]): Promise<void> {
  const previousUmask = process.umask(0o077);
  try {
    if (argv.length === 0) {
      process.stdout.write(USAGE);
      return;
    }
    const top = parseArgs({
      args: argv.slice(0, 1),
      options: { help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
    if (top.values.help) {
      process.stdout.write(USAGE);
      return;
    }
    await dispatch(top.positionals[0], argv.slice(1));
  } finally {
    process.umask(previousUmask);
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href)
  void main(process.argv.slice(2)).catch((error: unknown) => {
    createUi().error(describeError(error));
    process.exitCode = 1;
  });
