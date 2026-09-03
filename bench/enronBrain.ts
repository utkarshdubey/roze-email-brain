// Builds a brain from one public Enron inbox and turns that user's EnronQA questions into an
// evalAgent question file. Paid (extraction, promotion, synthesis) like any generate.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";

import { runGenerateCommand } from "../src/commands/generate.js";
import { EnronMaildirClient } from "./enron/enronClient.js";
import { runAsScript, writeOut } from "./script.js";

const rowSchema = z
  .object({ path: z.string(), questions: z.array(z.string()), gold_answers: z.array(z.string()) })
  .loose();

/** One item per EnronQA row this client could place in a thread; its folder becomes the category. */
function mapQuestionsToThreads(questionFile: string, client: EnronMaildirClient) {
  const rows = readFileSync(questionFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => rowSchema.parse(JSON.parse(line)));
  return rows.flatMap((row) => {
    const relativePath = row.path.replace(/^[^/]+\//u, "");
    const threadId = client.threadIdForPath(relativePath);
    if (!threadId) return [];
    return row.questions.slice(0, 1).map((question, index) => ({
      id: `${relativePath}#${index}`,
      question,
      category: relativePath.split("/")[0] ?? "folder",
      reference: row.gold_answers[index] ?? "",
      expect: { cite_any_of: [threadId] },
    }));
  });
}

/** Stable spread across the inbox: every k-th item rather than the first N. */
function spreadSample<Item>(items: readonly Item[], size: number): Item[] {
  const sample = Math.min(size, items.length);
  const step = Math.max(1, Math.floor(items.length / sample));
  return items.filter((_item, index) => index % step === 0).slice(0, sample);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      maildir: { type: "string" },
      questions: { type: "string" },
      root: { type: "string" },
      budget: { type: "string", default: "3" },
      sample: { type: "string", default: "60" },
      out: { type: "string" },
      "skip-generate": { type: "boolean" },
      "no-synthesize": { type: "boolean" },
    },
    strict: true,
  });
  if (!values.maildir || !values.root || !values.out)
    throw new Error(
      "Usage: tsx bench/enronBrain.ts --maildir <maildir/user> --root <brain dir> --out <questions.json> [--questions rows.jsonl] [--sample 60] [--budget 3] [--skip-generate]",
    );
  const client = new EnronMaildirClient(values.maildir);
  process.stderr.write(
    `Enron inbox ${values.maildir}: ${client.messageCount} messages, ${client.threadCount} threads, user ${client.userEmail}, latest ${client.latestDay}\n`,
  );
  if (!values["skip-generate"])
    await runGenerateCommand(["--budget", values.budget, ...(values["no-synthesize"] ? ["--no-synthesize"] : [])], {
      client,
      root: values.root,
      today: new Date(Date.parse(`${client.latestDay}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10),
    });
  if (!values.questions) return;
  const items = mapQuestionsToThreads(values.questions, client);
  const chosen = spreadSample(items, Number(values.sample));
  writeOut(values.out, `${JSON.stringify(chosen, null, 2)}\n`);
  process.stderr.write(`Wrote ${chosen.length} of ${items.length} mappable questions to ${values.out}\n`);
}

runAsScript(import.meta.url, main, "Enron brain");
