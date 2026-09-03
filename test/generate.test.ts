import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PUBLISH_TARGETS } from "../src/brain/storage.js";
import { runGenerateCommand } from "../src/commands/generate.js";
import type { GmailReader } from "../src/ingest/mail.js";
import type { CallModel } from "../src/llm/models.js";
import type { EmailThread, MessageHeader } from "../src/types.js";
import { message, USER } from "./helpers.js";

class FakeGmail implements GmailReader {
  async getProfile() {
    return { emailAddress: USER, messagesTotal: 2, threadsTotal: 2, historyId: "history-7" };
  }
  async listMessageIds() {
    return ["header-1", "header-2"];
  }
  async fetchMessageHeaders(id: string): Promise<MessageHeader> {
    if (id === "header-2")
      return {
        id,
        threadId: "bodyonly",
        timestamp: Date.parse("2026-08-27T13:00:00Z") / 1_000,
        day: "2026-08-27",
        fromName: "Shop",
        fromEmail: "newsletter@shop.example",
        subject: "Weekly deals",
        labels: [],
        listId: "",
        snippet: "Deals",
      };
    return {
      id,
      threadId: "promoted",
      timestamp: Date.parse("2026-08-29T13:00:00Z") / 1_000,
      day: "2026-08-29",
      fromName: "Alice",
      fromEmail: "alice@example.com",
      subject: "Useful update",
      labels: [],
      listId: "",
      snippet: "Useful",
    };
  }
  async listThreadIds() {
    return ["sent"];
  }
  async fetchThread(id: string): Promise<EmailThread> {
    if (id === "bodyonly")
      return { id, messages: [message(id, "2026-08-27", "newsletter@shop.example", "Weekly deals")] };
    return {
      id,
      messages: [message(id, id === "sent" ? "2026-08-28" : "2026-08-29", id === "sent" ? USER : "alice@example.com")],
    };
  }
}

function successfulModel(kinds: string[]): CallModel {
  return async (request) => {
    kinds.push(request.kind);
    const value =
      request.kind === "promotion"
        ? { decisions: [{ sender: "alice@example.com", read: "all" }] }
        : {
            summary: "Alice sent a useful update.",
            state: "none",
            state_note: "",
            mentions: [{ name: "Alice", kind: "person", email: "alice@example.com", org: "Example Co", role: "lead" }],
            items: [
              {
                entity: "Alice",
                entity_type: "person",
                date: request.user.includes("2026-08-29") ? "2026-08-29" : "2026-08-28",
                text: "Alice shared an update.",
                kind: "fact",
                loop_status: "",
              },
            ],
          };
    return request.schema.parse(value);
  };
}

test("generate publishes every target offline and reports only expected cost language", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "roze-generate-"));
  const root = join(workspace, "brain");
  try {
    const kinds: string[] = [];
    const output: string[] = [];
    const diagnostics: string[] = [];
    const metadata = await runGenerateCommand(["--no-synthesize"], {
      root,
      client: new FakeGmail(),
      callModel: successfulModel(kinds),
      today: "2026-09-02",
      write: (text) => output.push(text),
      writeError: (text) => diagnostics.push(text),
    });
    assert.equal(metadata?.userEmail, USER);
    assert.deepEqual(
      kinds,
      ["extraction", "promotion", "extraction"],
      "participated threads are extracted and published before the skim is promoted",
    );
    assert.match(
      output.join(""),
      /Phase 1\/4 published .*roze prompt.*\nPhase 2\/4 published.*\nPhase 3\/4 published.*\nPhase 4\/4 published after \d+s: raw bodies stored for 1 of 1/u,
    );
    assert.ok(existsSync(join(root, "evidence", "threads", "bodyonly.md")), "body-only thread is raw evidence");
    assert.match(
      readFileSync(join(root, "evidence", "inbox-2026.md"), "utf8"),
      /^bodyonly \| 2026-08-27 \| newsletter@shop\.example \| auto \| 1 msgs \| Weekly deals \| Deals \| body$/mu,
    );
    assert.doesNotMatch(
      readFileSync(join(root, "threads", "INDEX.md"), "utf8"),
      /bodyonly/u,
      "and it is never summarized",
    );
    assert.equal(metadata?.counts.bodyThreads, 1);
    assert.equal(metadata?.counts.transactions, 0, "fixture mail states no amounts");
    assert.deepEqual(
      {
        threads: metadata?.counts.threads,
        messages: metadata?.counts.messages,
        promoted: metadata?.counts.promoted,
        projects: metadata?.counts.durableProjects,
      },
      { threads: 2, messages: 2, promoted: 1, projects: 0 },
    );
    for (const target of PUBLISH_TARGETS) assert.ok(existsSync(join(root, target)), target);
    assert.ok(existsSync(join(root, ".cache", USER, "threads")), "caches are scoped by account");
    const meta = JSON.parse(readFileSync(join(root, "meta.json"), "utf8"));
    assert.deepEqual(Object.keys(meta).sort(), [
      "build",
      "counts",
      "generatedAt",
      "historyId",
      "timezone",
      "userEmail",
    ]);
    assert.deepEqual(meta.build, { phase: 4, phases: 4, complete: true, pending: [] });
    assert.match(readFileSync(join(root, "INDEX.md"), "utf8"), /Build status: complete\./u);
    assert.match(diagnostics.join(""), /expected ≈ \$/u);
    assert.doesNotMatch([...output, ...diagnostics].join(""), /hard (cost )?ceiling/iu);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("zero budget refuses before the first paid stage and leaves the old brain untouched", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "roze-budget-"));
  const root = join(workspace, "brain");
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "INDEX.md"), "old-index");
    writeFileSync(join(root, "meta.json"), "old-meta");
    let calls = 0;
    await assert.rejects(
      runGenerateCommand(["--no-synthesize", "--budget", "0"], {
        root,
        client: new FakeGmail(),
        callModel: async () => {
          calls += 1;
          throw new Error("budget was late");
        },
        today: "2026-09-02",
        write: () => undefined,
        writeError: () => undefined,
      }),
      /extraction expected cost .*remaining --budget/u,
    );
    assert.equal(calls, 0);
    assert.equal(readFileSync(join(root, "INDEX.md"), "utf8"), "old-index");
    assert.equal(readFileSync(join(root, "meta.json"), "utf8"), "old-meta");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("--publish-once builds every phase but publishes only the complete brain", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "roze-generate-once-"));
  const root = join(workspace, "brain");
  try {
    const kinds: string[] = [];
    const output: string[] = [];
    const metadata = await runGenerateCommand(["--no-synthesize", "--publish-once"], {
      root,
      client: new FakeGmail(),
      callModel: successfulModel(kinds),
      today: "2026-09-02",
      write: (text) => output.push(text),
      writeError: () => undefined,
    });
    assert.equal(metadata?.build.complete, true);
    assert.equal(metadata?.counts.threads, 2);
    assert.match(
      output.join(""),
      /Phase 1\/4 ready .*publishing once at the end.*\nPhase 2\/4 ready.*\nPhase 3\/4 ready.*\nPhase 4\/4 published/u,
    );
    assert.doesNotMatch(output.join(""), /Phase [123]\/4 published/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
