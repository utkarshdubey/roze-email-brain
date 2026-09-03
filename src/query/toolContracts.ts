// The typed contract of the three memory tools. Argument schemas are strict, so an unexpected field is
// rejected before any file is touched, and the same schema object is both the runtime validator and the
// JSON Schema the provider is given — they cannot drift apart.
import { z } from "zod";

import { SEARCH_SCOPES } from "../brain/storage.js";
import type { FunctionTool } from "../llm/provider.js";

const MATCHES = ["all_terms", "any_term"] as const;
const GROUPS = ["none", "subject", "sender", "merchant", "kind", "currency", "day", "month", "year"] as const;

export const searchArguments = z
  .object({
    query: z.string().min(1).max(200),
    scope: z.enum(SEARCH_SCOPES),
    match: z.enum(MATCHES),
    limit: z.number().int().min(1).max(30),
    /** Tally every matching row instead of listing a few: how "most often" is answered. */
    group_by: z.enum(GROUPS),
    /** With a tally over transactions: also sum the amount column ("how much did I spend"). */
    amounts: z.enum(["ignore", "sum"]),
    /** Inclusive day bounds; the harness filters and sums, so the model never does date arithmetic. */
    from: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/u),
    to: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/u),
  })
  .strict();

export const readArguments = z
  .object({
    path: z.string().min(1).max(300),
    start_line: z.number().int().min(1),
    max_lines: z.number().int().min(1).max(500),
  })
  .strict();

export const readEmailArguments = z.object({ thread_id: z.string().regex(/^[0-9a-f]{8,}$/u) }).strict();

export type Match = z.infer<typeof searchArguments>["match"];
export type Group = z.infer<typeof searchArguments>["group_by"];
export type Amounts = z.infer<typeof searchArguments>["amounts"];

const defineTool = (name: string, description: string, schema: z.ZodType): FunctionTool => ({
  type: "function",
  name,
  description,
  strict: true,
  parameters: z.toJSONSchema(schema, { target: "draft-07", io: "input" }),
});

export const TOOL_DEFINITIONS = [
  defineTool(
    "search_memory",
    "Literal, case-insensitive search over generated memory files. Scopes: people, organizations, projects, " +
      "interests, open_loops (derived views that point at threads), thread_summaries (per-thread summary, " +
      "state, and the per-year lists of full-read and header-only mail), evidence (raw email text). " +
      "group_by=none lists the best few matching lines. " +
      "group_by=subject|sender|merchant|kind|currency|day|month|year counts EVERY matching row instead, " +
      "returning the largest groups with one example citation each. scope=transactions holds typed rows " +
      "parsed at build time (merchant, kind: order|refund|subscription|invoice|transfer|receipt, amount, " +
      "currency); amounts=sum totals their amount column as printed, so group by currency when a mailbox " +
      "mixes currencies. from/to (YYYY-MM-DD, inclusive, or empty) bound a tally to a period so the total " +
      "for a range comes back computed; pass an empty string for no bound and never add rows up yourself. " +
      "Use tallies for how-often, how-many, most-common, and how-much questions; a handful of read threads " +
      "can never answer them.",
    searchArguments,
  ),
  defineTool(
    "read_memory",
    "Read a bounded line range from one generated Markdown path returned by an index or search. A long file " +
      "stops with a continuation hint naming the next start_line; keep reading until the final message " +
      "before stating an outcome.",
    readArguments,
  ),
  defineTool(
    "read_email",
    "Fetch one Gmail thread live by id, only for skim-tier rows from evidence/inbox-<year>.md that have no " +
      "evidence/threads/<id>.md file. For any thread listed in threads/ or evidence/threads-<year>.md use " +
      "read_memory on evidence/threads/<id>.md instead.",
    readEmailArguments,
  ),
];

/** Longer output keeps both ends and drops the middle. */
const MAX_TOOL_OUTPUT = 6_000;

export function linesOf(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/** The head orients, the tail carries the latest rows. */
export function capMiddle(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  const marker = `\n…[middle omitted; ${text.length} chars total]…\n`;
  const before = Math.floor((MAX_TOOL_OUTPUT - marker.length) / 2);
  return text.slice(0, before) + marker + text.slice(-(MAX_TOOL_OUTPUT - marker.length - before));
}
