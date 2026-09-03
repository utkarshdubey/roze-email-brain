// One structured extraction per full-read thread. The prompt text and the cache request shape are
// load-bearing: changing either invalidates every cached extraction and re-pays for the whole mailbox.
import { z } from "zod";
import { renderThreadAsMarkdown } from "../brain/renderEvidence.js";
import { mapAtLimitedConcurrency, type PipelineContext } from "../context.js";
import { MODELS, quoteCost, readCachedModelCall, readCacheOrCall, type CachedModelRequest } from "../llm/models.js";
import { cleanText } from "../shared/text.js";
import { threadIncludesUser, type EmailThread, type ThreadExtraction } from "../types.js";

const WORKERS = 16;

/** Inbox-only threads are read shallowly: a truncated body and a smaller item budget. */
const LITE_BODY_CHARS = 1_500;

const extractionResponseSchema = z
  .object({
    summary: z.string(),
    state: z.enum(["open", "resolved", "none"]),
    state_note: z.string(),
    mentions: z.array(
      z
        .object({
          name: z.string(),
          kind: z.enum(["person", "organization"]),
          email: z.string(),
          org: z.string(),
          role: z.string(),
        })
        .strict(),
    ),
    items: z.array(
      z
        .object({
          entity: z.string(),
          entity_type: z.string(),
          date: z.string(),
          text: z.string(),
          kind: z.enum(["fact", "loop"]),
          loop_status: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
type RawExtraction = z.infer<typeof extractionResponseSchema>;

// `{user_email}` and `{today}` are the only placeholders; `{{`/`}}` are literal braces, so the worked
// example can show JSON without its braces reading as placeholders.
const SYSTEM = `You turn ONE email thread into memory for a personal assistant. The user is {user_email} ("you").
Today is {today}. Be terse and concrete; names, dates, amounts. Output:

- summary: 1-2 sentences: what this thread was about and how it ended.
- state: "open" if the thread leaves something unresolved that matters to the user (a reply owed, a decision
  pending, money outstanding, a scheduled follow-up); "resolved" if it ended with a clear outcome (done, declined,
  rejected, paid, cancelled); "none" for chit-chat, notifications, or nothing actionable. state_note: the outcome
  or what is still pending, one line (e.g. "rejected by Acme on 2026-04-14", "waiting on Sam for next steps").
- mentions: every person or organization that appears as a real participant or subject (not the user, not
  mailing lists). kind is person or organization. Use the person's full name when it appears anywhere in the
  thread (signature, greeting), else the name as written. email may be "" when unknown; org is the company/school
  a person belongs to if evident; role is their relation to the user in a few words (recruiter at Acme, landlord).
- items: memory items worth keeping, 0-8 per thread. Each is ONE sentence about ONE entity, written from the
  user's point of view, with the YYYY-MM-DD date of the message that supports it. entity should normally be a
  mention's name (the person or organization the item is about); use a short project/topic label instead only
  when the item is not really about any mention (e.g. "EAD start date", "Apartment move-out"). entity_type is
  free text: person, organization, project, interest, place, account, or something better. kind="loop" for a \
commitment/follow-up/decision; then loop_status is "open"
  or "resolved: <reason>" (rejected, done, declined, expired, paid). Only keep a loop if it has a date or an
  amount, or involves a named person, or the user started the thread; drop trivia and automated notices.
  Skip newsletters and marketing entirely: summary only, no items.

Worked example. Input thread (abridged): on 2026-03-27 dana@acme.example (Talent Lead, Acme) writes \
"great to connect today; next is a 1-hour technical round with Priya, pick a slot"; on 2026-03-30 \
priya@acme.example sends a scheduling link; on 2026-04-02 the user books it and asks what the round covers; \
on 2026-04-03 Priya answers "it's in Python, a problem we've faced here, no specialized knowledge needed"; \
on 2026-04-14 dana@acme.example writes "thank you for the time you put in; we won't be moving forward at \
this time, we went with another candidate".
Output:
summary: "Acme interview process after the intro call with Dana: Priya ran a Python problem-solving round; \
on 2026-04-14 Dana said Acme would not move forward and had chosen another candidate."
state: "resolved"; state_note: "rejected by Acme (Dana Ruiz) on 2026-04-14"
mentions: [{{"name": "Dana Ruiz", "kind": "person", "email": "dana@acme.example", "org": "Acme", \
"role": "talent lead at Acme"}}, {{"name": "Priya", "kind": "person", "email": "priya@acme.example", \
"org": "Acme", "role": "interviewer at Acme"}}, {{"name": "Acme", "kind": "organization", "email": "", \
"org": "", "role": "company I interviewed with"}}]
items: [{{"entity": "Acme", "entity_type": "organization", "date": "2026-04-14", "text": "Acme rejected \
me after the technical round; they went with another candidate.", "kind": "loop", \
"loop_status": "resolved: rejected"}}, {{"entity": "Priya", "entity_type": "person", "date": "2026-04-03", \
"text": "Priya said the Acme coding round would be in Python, based on a real problem they faced, with no \
specialized knowledge needed.", "kind": "fact", "loop_status": ""}}]
Notice: dates come from the message that supports each item; the loop is resolved because the thread ended \
with a clear no; scheduling back-and-forth produced no items of its own.`;
export const LITE_NOTE = `
This thread was NOT replied to by the user (inbox only). Be brief: at most 4 items, and only if they carry a \
date, an amount, a named person, or a commitment the user must act on. Receipts, shipping notices, digests, \
and marketing get summary only.`;

function formatExtractionSystemPrompt(userEmail: string, today: string): string {
  return SYSTEM.replaceAll(/\{\{|\}\}|\{user_email\}|\{today\}/gu, (token) => {
    if (token === "{{") return "{";
    if (token === "}}") return "}";
    return token === "{user_email}" ? userEmail : today;
  });
}

function renderTextForExtraction(thread: EmailThread, userEmail: string): string {
  if (threadIncludesUser(thread, userEmail)) return renderThreadAsMarkdown(thread, userEmail);
  // Spread by code point, so truncation never splits an emoji or a CJK pair.
  const messages = thread.messages.map((message) => ({
    ...message,
    body: [...message.body].slice(0, LITE_BODY_CHARS).join(""),
  }));
  return renderThreadAsMarkdown({ ...thread, messages }, userEmail) + LITE_NOTE;
}

export function buildExtractionRequest(
  thread: EmailThread,
  userEmail: string,
  context: PipelineContext,
): CachedModelRequest<RawExtraction> {
  // The as-of day is the thread's own last message day, so an unchanged thread keeps its cache forever.
  return {
    kind: "extraction",
    system: formatExtractionSystemPrompt(userEmail, thread.messages.at(-1)?.day ?? ""),
    user: renderTextForExtraction(thread, userEmail),
    schema: extractionResponseSchema,
    model: MODELS.extract,
    effort: "minimal",
    cacheDir: context.paths.cachedExtractionsDir,
  };
}

export function readCachedExtraction(
  thread: EmailThread,
  userEmail: string,
  context: PipelineContext,
): ThreadExtraction | undefined {
  const cached = readCachedModelCall(buildExtractionRequest(thread, userEmail, context));
  return cached ? mapExtraction(cached, thread, userEmail) : undefined;
}

function mapExtraction(raw: RawExtraction, thread: EmailThread, userEmail: string): ThreadExtraction {
  const first = thread.messages[0];
  const last = thread.messages.at(-1);
  if (!first || !last) throw new Error(`Cannot extract memory from empty thread ${thread.id}`);
  return {
    threadId: thread.id,
    firstDay: first.day,
    lastDay: last.day,
    messageDays: [...new Set(thread.messages.map((message) => message.day).filter(Boolean))],
    userStarted: first.fromEmail.toLowerCase() === userEmail.toLowerCase(),
    summary: cleanText(raw.summary),
    state: raw.state,
    stateNote: cleanText(raw.state_note),
    mentions: raw.mentions.map((row) => ({
      name: cleanText(row.name),
      kind: row.kind,
      email: cleanText(row.email).toLowerCase(),
      org: cleanText(row.org),
      role: cleanText(row.role),
    })),
    items: raw.items.slice(0, threadIncludesUser(thread, userEmail) ? 8 : 4).map((row) => ({
      entity: cleanText(row.entity),
      entityType: cleanText(row.entity_type),
      date: cleanText(row.date),
      text: cleanText(row.text),
      kind: row.kind,
      loopStatus: cleanText(row.loop_status),
    })),
  };
}

export async function extractMemoryFromThread(
  thread: EmailThread,
  userEmail: string,
  context: PipelineContext,
): Promise<ThreadExtraction> {
  if (!thread.messages.length) throw new Error(`Cannot extract memory from empty thread ${thread.id}`);
  const cached = readCachedExtraction(thread, userEmail, context);
  if (cached) return cached;
  const raw = await readCacheOrCall(buildExtractionRequest(thread, userEmail, context), context.callModel);
  return mapExtraction(raw, thread, userEmail);
}

/** One thread the model cannot process is skipped with a visible warning and retried next run. */
export async function extractMemoryFromAllThreads(
  threads: readonly EmailThread[],
  userEmail: string,
  context: PipelineContext,
): Promise<ThreadExtraction[]> {
  const source = threads.filter((thread) => thread.messages.length);
  const failures: string[] = [];
  const results = await mapAtLimitedConcurrency(
    source,
    WORKERS,
    async (thread) => {
      try {
        return await extractMemoryFromThread(thread, userEmail, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A budget or ceiling stop is the build's answer, not one thread's failure; never swallow it.
        if (/budget|ceiling|credit/iu.test(message)) throw error;
        failures.push(`${thread.id}: ${cleanText(message, 300)}`);
        return undefined;
      }
    },
    (done) => context.log("extracting", done, source.length),
  );
  for (const failure of failures) {
    context.log(`  warning: extraction skipped thread ${failure}`);
  }
  if (failures.length) {
    context.log(`  ${failures.length} thread(s) skipped; they will be retried on the next generate`);
  }
  return results.filter((row): row is ThreadExtraction => row !== undefined);
}

/** Only uncached threads cost anything, so the estimate falls to zero as a stopped build is resumed. */
export function estimateExtractionCost(threads: readonly EmailThread[], userEmail: string, context: PipelineContext) {
  const work = threads.filter((thread) => thread.messages.length && !readCachedExtraction(thread, userEmail, context));
  // Rough token shape of one call: 3.6 characters per token, plus the prompt, against a fixed answer.
  const inputTokens = Math.trunc(
    work.reduce((sum, thread) => sum + renderTextForExtraction(thread, userEmail).length / 3.6 + 1_100, 0),
  );
  const outputTokens = work.length * 160;
  return {
    calls: work.length,
    items: work.length,
    cached: threads.length - work.length,
    inputTokens,
    outputTokens,
    usd: quoteCost(MODELS.extract, inputTokens, outputTokens),
    model: MODELS.extract,
  };
}
