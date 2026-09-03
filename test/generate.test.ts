import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PUBLISH_TARGETS, resolveBrainPaths } from "../src/brain/storage.js";
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
  // The participation queries name the sent and starred tiers; anything else is the skim's own listing.
  async listThreadIds(query: string) {
    return query.startsWith("newer_than:") ? ["promoted", "bodyonly"] : ["sent"];
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

/**
 * A mailbox whose fast skim lists one newsletter message and whose backfill listing adds a second thread
 * the automation exclusions hid. `gate`, when given, holds the fast-skim thread's body until it settles,
 * so a body fetch can be made to depend on the concept judge having started.
 */
class SkimGmail implements GmailReader {
  readonly threadReads: string[] = [];
  constructor(private readonly gate?: Promise<void>) {}
  async getProfile() {
    return { emailAddress: USER, messagesTotal: 3, threadsTotal: 3, historyId: "history-8" };
  }
  async listMessageIds() {
    return ["header-1"];
  }
  async fetchMessageHeaders(id: string): Promise<MessageHeader> {
    return {
      id,
      threadId: "fastskim",
      timestamp: Date.parse("2026-08-27T13:00:00Z") / 1_000,
      day: "2026-08-27",
      fromName: "Shop",
      fromEmail: "newsletter@shop.example",
      subject: "Weekly deals",
      labels: [],
      listId: "",
      snippet: "Deals",
    };
  }
  async listThreadIds(query: string) {
    return query.startsWith("newer_than:") ? ["fastskim", "backfilled"] : ["sent"];
  }
  async fetchThread(id: string): Promise<EmailThread> {
    this.threadReads.push(id);
    if (id === "fastskim") {
      await this.gate;
      return { id, messages: [message(id, "2026-08-27", "newsletter@shop.example", "Weekly deals")] };
    }
    if (id === "backfilled")
      return { id, messages: [message(id, "2026-08-26", "billing@bank.example", "Statement ready")] };
    return { id, messages: [message(id, "2026-08-28", USER)] };
  }
}

/** Ignores every sender, tags nothing, and judges no cluster, so only the call sequence is under test. */
function emptyConceptModel(kinds: string[], onConceptCall: () => void = () => undefined): CallModel {
  return async (request) => {
    kinds.push(request.kind);
    if (request.kind === "promotion") return request.schema.parse({ decisions: [] });
    if (request.kind === "topics") {
      onConceptCall();
      return request.schema.parse({ threads: [] });
    }
    if (request.kind === "judge") {
      onConceptCall();
      return request.schema.parse({ clusters: [] });
    }
    return request.schema.parse({
      summary: "A note.",
      state: "none",
      state_note: "",
      mentions: [],
      items: [],
    });
  };
}

test("the complete backfill caches the threads it reads, so the body phase never fetches them twice", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "roze-generate-backfill-"));
  const root = join(workspace, "brain");
  try {
    const kinds: string[] = [];
    const output: string[] = [];
    const client = new SkimGmail();
    const metadata = await runGenerateCommand(["--no-synthesize"], {
      root,
      client,
      callModel: emptyConceptModel(kinds),
      today: "2026-09-02",
      write: (text) => output.push(text),
      writeError: () => undefined,
    });
    assert.deepEqual(
      client.threadReads,
      ["sent", "backfilled", "fastskim"],
      "the backfill reads its thread in full once and the body phase reads only the fast-skim thread",
    );
    assert.ok(
      existsSync(join(root, ".cache", USER, "threads", "backfilled.json")),
      "the backfilled thread is in the thread cache before the body phase starts",
    );
    assert.equal(metadata?.counts.bodyThreads, 2, "both skim threads still have raw bodies");
    assert.match(output.join(""), /Phase 4\/4 published after \d+s: raw bodies stored for 2 of 2/u);
    assert.match(
      readFileSync(join(root, "evidence", "inbox-2026.md"), "utf8"),
      /^backfilled \| 2026-08-26 \| billing@bank\.example \| auto \| 1 msgs \| Statement ready \| Useful update \| body$/mu,
      "and its index row is derived from the thread, in the row format a metadata read would have produced",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the concept judge runs while the bodies are still being fetched", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "roze-generate-overlap-"));
  const root = join(workspace, "brain");
  let openGate: () => void = () => undefined;
  let failGate: (error: Error) => void = () => undefined;
  const gate = new Promise<void>((accept, reject) => {
    openGate = accept;
    failGate = reject;
  });
  // Without the overlap the body fetch would wait forever; the timer turns that into a named failure.
  const timer = setTimeout(() => failGate(new Error("the judge never ran while bodies were fetching")), 10_000);
  try {
    const kinds: string[] = [];
    const output: string[] = [];
    const client = new SkimGmail(gate);
    let bodiesDone = false;
    const metadata = await runGenerateCommand([], {
      root,
      client,
      callModel: emptyConceptModel(kinds, () => {
        assert.equal(bodiesDone, false, "the judge's first model call happens before the bodies are stored");
        openGate();
      }),
      today: "2026-09-02",
      write: (text) => {
        bodiesDone ||= /Phase 4\/5 published/u.test(text);
        output.push(text);
      },
      writeError: () => undefined,
    });
    assert.ok(kinds.includes("topics"), "the judge stage ran");
    assert.match(
      output.join(""),
      /Phase 4\/5 published after \d+s: raw bodies stored for 2 of 2 remaining inbox threads, concepts judged alongside\.[\s\S]*Phase 5\/5 published after \d+s: 0 projects, 0 interests\./u,
    );
    assert.equal(metadata?.build.complete, true);
    assert.equal(metadata?.counts.bodyThreads, 2);
  } finally {
    clearTimeout(timer);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("generate publishes every target offline and reports only expected cost language", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "roze-generate-"));
  const root = join(workspace, "brain");
  try {
    const staleSearchIndex = resolveBrainPaths(root, USER).searchIndexFile;
    mkdirSync(join(root, ".cache", USER), { recursive: true });
    writeFileSync(staleSearchIndex, "stale derived index");
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
    assert.ok(!existsSync(staleSearchIndex), "a successful publication invalidates the derived search index");
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
