// Small shared values for stage-level tests; substantive fixtures stay beside the behavior they prove.
import type { PipelineContext } from "../src/context.js";
import { resolveBrainPaths } from "../src/brain/storage.js";
import type { CallModel } from "../src/llm/models.js";
import type { EmailMessage, EmailThread, ThreadExtraction } from "../src/types.js";

export const USER = "owner@example.com";

export function message(
  threadId: string,
  day: string,
  fromEmail = "alice@example.com",
  subject = "Example",
  labels: string[] = [],
): EmailMessage {
  return {
    id: `${threadId}-${day}-${fromEmail}`,
    threadId,
    date: `${day}T09:00-04:00`,
    day,
    timestamp: Date.parse(`${day}T13:00:00Z`) / 1_000,
    fromName: fromEmail.split("@")[0] ?? "",
    fromEmail,
    to: fromEmail === USER ? "Alice <alice@example.com>" : `Owner <${USER}>`,
    cc: "",
    subject,
    labels,
    listId: "",
    snippet: "Useful update",
    body: "RAW BODY: useful update.",
  };
}

export function thread(id: string, days: string[], senders: string[] = []): EmailThread {
  return {
    id,
    messages: days.map((day, index) => message(id, day, senders[index] ?? (index ? USER : "alice@example.com"))),
  };
}

export function extraction(source: EmailThread, changes: Partial<ThreadExtraction> = {}): ThreadExtraction {
  return {
    threadId: source.id,
    firstDay: source.messages[0]?.day ?? "",
    lastDay: source.messages.at(-1)?.day ?? "",
    messageDays: source.messages.map((row) => row.day),
    userStarted: source.messages[0]?.fromEmail === USER,
    summary: "Useful update.",
    state: "none",
    stateNote: "",
    mentions: [],
    items: [],
    ...changes,
  };
}

export function context(
  root: string,
  answer: unknown | ((kind: string) => unknown),
  log: PipelineContext["log"] = () => undefined,
): PipelineContext {
  const callModel: CallModel = async (request) =>
    request.schema.parse(typeof answer === "function" ? answer(request.kind) : answer);
  return { paths: resolveBrainPaths(root), callModel, today: "2026-09-02", log };
}
