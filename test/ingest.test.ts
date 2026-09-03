import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { rememberOnDemandThreadId } from "../src/ingest/cache.js";
import {
  AUTOMATED_SENDER_TERMS,
  buildSkimQuery,
  fetchRecentInboxHeaders,
  fetchThreadsById,
  learnAutomatedDomains,
  listParticipatedThreadIds,
  listSkimThreads,
} from "../src/ingest/mail.js";
import { decideWhatToReadPerSender, estimatePromotionCost } from "../src/ingest/promote.js";
import { GmailRequestError } from "../src/gmail/client.js";
import { looksLikeAHuman, type MessageHeader } from "../src/types.js";
import { context, message } from "./helpers.js";

function header(sender: string, id: string, timestamp: number, changes: Partial<MessageHeader> = {}): MessageHeader {
  return {
    id: `m-${id}`,
    threadId: id,
    timestamp,
    day: "2026-08-28",
    fromName: "Sender",
    fromEmail: sender,
    subject: `Subject ${id}`,
    labels: [],
    listId: "",
    snippet: "",
    ...changes,
  };
}

test("automation signals override names and promotion applies all/recent/latest limits", async () => {
  const root = mkdtempSync(join(tmpdir(), "roze-ingest-"));
  try {
    assert.equal(looksLikeAHuman(header("person@example.com", "a", 1)), true);
    assert.equal(looksLikeAHuman(header("no-reply@example.com", "b", 1)), false);
    assert.equal(looksLikeAHuman(header("person@example.com", "c", 1, { listId: "news" })), false);
    const rows = [
      ...Array.from({ length: 30 }, (_, index) => header("alice@example.com", `alice-${index}`, 1_000_000 - index)),
      ...Array.from({ length: 7 }, (_, index) =>
        header("billing@shop.example", `bill-${index}`, 2_000_000 - index * 86_400),
      ),
      header("report@example.com", "report-new", 3_000_000),
      header("report@example.com", "report-old", 2_000_000),
      header("alice@example.com", "alice-code", 4_000_000, { subject: "Your one-time passcode is 123456" }),
    ];
    let calls = 0;
    let payload = "";
    const ctx = context(root, () => {
      calls += 1;
      return {
        decisions: [
          { sender: "alice@example.com", read: "all" },
          { sender: "billing@shop.example", read: "all" },
          { sender: "report@example.com", read: "latest" },
        ],
      };
    });
    ctx.callModel = (async (request: { user: string; kind: string; schema: { parse(value: unknown): unknown } }) => {
      payload = request.user;
      calls += 1;
      return request.schema.parse({
        decisions: [
          { sender: "alice@example.com", read: "all" },
          { sender: "billing@shop.example", read: "all" },
          { sender: "report@example.com", read: "latest" },
        ],
      });
    }) as typeof ctx.callModel;
    const first = await decideWhatToReadPerSender(
      rows.map((row, index) => (index === 0 ? { ...row, snippet: "Hi  Utkarsh,\nabout the\tlease" } : row)),
      ctx,
    );
    assert.match(
      payload,
      /alice@example\.com \| 30 threads \| latest 2026-08-28 \| Subject alice-0 — Hi Utkarsh, about the lease \|\| Subject alice-1/u,
      "promotion sees the Gmail snippet",
    );
    assert.equal(first.filter((id) => id.startsWith("alice-")).length, 25);
    assert.ok(!first.includes("alice-code"), "verification codes are never promoted");
    assert.doesNotMatch(payload, /one-time passcode/u, "and never shown to the promotion model");
    assert.deepEqual(
      first.filter((id) => id.startsWith("bill-")),
      ["bill-0", "bill-1", "bill-2", "bill-3", "bill-4"],
    );
    assert.ok(first.includes("report-new"));
    await decideWhatToReadPerSender(
      rows,
      context(root, () => {
        throw new Error("decision cache missed");
      }),
    );
    assert.equal(calls, 1);
    assert.equal(estimatePromotionCost(rows, ctx).calls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("header and full-thread fetches resume from files and keep deterministic order", async () => {
  const root = mkdtempSync(join(tmpdir(), "roze-ingest-cache-"));
  try {
    let headers = 0;
    let threads = 0;
    const client = {
      async listMessageIds() {
        return ["h1", "h2"];
      },
      async fetchMessageHeaders(id: string) {
        headers += 1;
        return header("alice@example.com", `thread-${id}`, id === "h1" ? 2 : 1, { id });
      },
      async listThreadIds() {
        return ["t2", "t1"];
      },
      async fetchThread(id: string) {
        threads += 1;
        return { id, messages: [message(id, id === "t1" ? "2026-01-01" : "2026-02-01")] };
      },
    };
    const ctx = context(root, {});
    assert.deepEqual(
      (await fetchRecentInboxHeaders(client, ctx)).map((row) => row.id),
      ["h1", "h2"],
    );
    assert.deepEqual(
      (await fetchThreadsById(client, [...(await listParticipatedThreadIds(client, ctx)), "t1"], ctx)).map(
        (row) => row.id,
      ),
      ["t1", "t2"],
    );
    await fetchRecentInboxHeaders(client, ctx);
    await fetchThreadsById(client, await listParticipatedThreadIds(client, ctx), ctx);
    assert.deepEqual({ headers, threads }, { headers: 2, threads: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the skim learns bulk domains from a sample and excludes them from the second listing", async () => {
  const root = mkdtempSync(join(tmpdir(), "roze-ingest-skim-"));
  try {
    const queries: string[] = [];
    const fetched: string[] = [];
    const threadsRead: string[] = [];
    const rows: Record<string, MessageHeader> = {
      a1: header("digest@bulk.example", "a1", 3),
      a2: header("digest@bulk.example", "a2", 2),
      a3: header("news@bulk.example", "a3", 1),
      h1: header("carol@friend.example", "h1", 5),
      h2: header("carol@friend.example", "h2", 4),
    };
    const client = {
      async listMessageIds(query: string, limit = 100_000) {
        queries.push(query);
        if (query.startsWith("newer_than:6m")) return ["h1"];
        return Object.keys(rows)
          .filter((id) => !query.includes("bulk.example") || !id.startsWith("a"))
          .slice(0, limit);
      },
      async fetchMessageHeaders(id: string) {
        fetched.push(id);
        return { ...rows[id]!, id };
      },
      // The backfill lists threads; "b1" is the one the automated-sender exclusions hid from the fast pass.
      async listThreadIds(query: string, limit = 100_000) {
        queries.push(query);
        return [...Object.keys(rows), "b1"].slice(0, limit);
      },
      async fetchThread(id: string) {
        threadsRead.push(id);
        return { id, messages: [message(id, "2026-08-20", "billing@bulk.example", "Statement ready")] };
      },
    };
    const skim = await fetchRecentInboxHeaders(client, context(root, {}));
    assert.deepEqual(
      skim.map((row) => row.id),
      ["h1", "h2", "a1", "a2", "a3"],
      "every fetched header is indexed, newest first",
    );
    assert.equal(queries.length, 2);
    assert.ok(
      queries[0]!.startsWith("newer_than:2y -in:sent -in:chats -category:promotions -category:social -from:noreply"),
    );
    assert.match(queries[1]!, / -from:bulk\.example$/u);
    assert.equal(fetched.length, 5, "every id from the sample listing is fetched once");
    const complete = await fetchRecentInboxHeaders(client, context(root, {}), "complete");
    assert.equal(queries.length, 3);
    assert.equal(
      queries[2],
      "newer_than:2y -in:sent -in:chats -category:promotions -category:social",
      "the backfill lists without exclusions",
    );
    assert.equal(fetched.length, 5, "the backfill never reads a metadata header");
    assert.deepEqual(threadsRead, ["b1"], "it reads the one uncovered thread in full, and the covered ones not at all");
    assert.deepEqual(
      complete.find((row) => row.threadId === "b1"),
      {
        id: "b1-2026-08-20-billing@bulk.example",
        threadId: "b1",
        timestamp: Date.parse("2026-08-20T13:00:00Z") / 1_000,
        day: "2026-08-20",
        fromName: "billing",
        fromEmail: "billing@bulk.example",
        subject: "Statement ready",
        labels: [],
        listId: "",
        count: 1,
        snippet: "Useful update",
      },
      "the index row is derived from the fetched thread's first message",
    );
    await fetchRecentInboxHeaders(client, context(root, {}), "complete");
    assert.deepEqual(threadsRead, ["b1"], "and a rerun re-derives the row from the thread cache for free");
    assert.deepEqual(learnAutomatedDomains([rows.a1!, rows.a2!, rows.h1!]), [], "three automated rows are required");
    assert.deepEqual(learnAutomatedDomains([rows.a1!, rows.a2!, rows.a3!, header("alerts@x.example", "x", 1)]), [
      "bulk.example",
    ]);
    for (const term of AUTOMATED_SENDER_TERMS)
      assert.equal(looksLikeAHuman(header(`${term}@shop.example`, "t", 1)), false, term);
    assert.equal(buildSkimQuery(24, ["a.example"]).split(" -from:").length, AUTOMATED_SENDER_TERMS.length + 2);
    assert.match(buildSkimQuery(6), /^newer_than:6m /u);
    assert.throws(() => buildSkimQuery(0), /positive integer/u);
    assert.deepEqual(
      (await fetchRecentInboxHeaders(client, context(root, {}), "fast", undefined, 6)).map((row) => row.threadId),
      ["h1"],
      "a shorter window does not leak older rows already present in the header cache",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the complete backfill reads single-message threads as one message and the rest in full", async () => {
  const root = mkdtempSync(join(tmpdir(), "roze-ingest-single-"));
  try {
    const reads: string[] = [];
    const client = {
      async listMessageIds() {
        return [];
      },
      async fetchMessageHeaders(id: string) {
        return header("alice@example.com", id, 1, { id });
      },
      async listThreadIds() {
        return ["t1", "t2"];
      },
      async listMessages() {
        return [
          { id: "m1", threadId: "t1" },
          { id: "m2a", threadId: "t2" },
          { id: "m2b", threadId: "t2" },
        ];
      },
      async fetchThread(id: string) {
        reads.push(`thread ${id}`);
        return {
          id,
          messages: [message(`${id}-a`, "2026-01-01"), message(`${id}-b`, "2026-01-02")].map((row) => ({
            ...row,
            threadId: id,
          })),
        };
      },
      async fetchSingleMessageThread(messageId: string, threadId: string) {
        reads.push(`message ${messageId}`);
        return { id: threadId, messages: [{ ...message(messageId, "2026-01-03"), threadId }] };
      },
    };
    const ctx = context(root, {});
    const listing = await listSkimThreads(client);
    assert.deepEqual([...listing], [
      ["t1", ["m1"]],
      ["t2", ["m2a", "m2b"]],
    ]);
    const rows = await fetchRecentInboxHeaders(client, ctx, "complete", listing);
    assert.deepEqual(reads.sort(), ["message m1", "thread t2"]);
    assert.deepEqual(
      rows.map((row) => [row.threadId, row.count]).sort(),
      [
        ["t1", 1],
        ["t2", 2],
      ],
    );
    // The body fetch finds both in the cache, and a client without message listing reads everything in full.
    await fetchThreadsById(client, ["t1", "t2"], ctx, "bodies", listing);
    assert.equal(reads.length, 2);
    const { listMessages, fetchSingleMessageThread, ...plain } = client;
    void listMessages;
    void fetchSingleMessageThread;
    assert.deepEqual([...(await listSkimThreads(plain))], [
      ["t1", []],
      ["t2", []],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("threads pulled on demand by the agent join the participated set on the next generate", async () => {
  const root = mkdtempSync(join(tmpdir(), "roze-ingest-demand-"));
  try {
    const ctx = context(root, {});
    rememberOnDemandThreadId("abcdef12", ctx.paths);
    rememberOnDemandThreadId("abcdef12", ctx.paths);
    assert.throws(() => rememberOnDemandThreadId("../x", ctx.paths));
    const client = {
      async listThreadIds(query: string) {
        assert.match(query, /-in:chats$/u, "chat conversations are never listed");
        return query.startsWith("is:starred") ? ["starred1"] : ["t1"];
      },
      async fetchThread(id: string) {
        return { id, messages: [message(id, "2026-01-01")] };
      },
    };
    assert.deepEqual(
      (await fetchThreadsById(client, await listParticipatedThreadIds(client, ctx), ctx)).map((row) => row.id).sort(),
      ["abcdef12", "starred1", "t1"],
      "replied, starred, and on-demand threads are all read in full",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a thread Gmail refuses with a precondition failure is skipped with a warning, other failures still abort", async () => {
  const root = mkdtempSync(join(tmpdir(), "roze-ingest-refused-"));
  try {
    const logs: string[] = [];
    const ctx = context(root, {}, (stage) => {
      logs.push(stage);
    });
    const client = {
      async listThreadIds() {
        return ["ok1", "chat1", "ok2"];
      },
      async fetchThread(id: string) {
        if (id === "chat1")
          throw new GmailRequestError(
            'Gmail request failed (400 Bad Request): { "message": "Precondition check failed." }',
            400,
          );
        return { id, messages: [message(id, "2026-01-01")] };
      },
    };
    assert.deepEqual(
      (await fetchThreadsById(client, await listParticipatedThreadIds(client, ctx), ctx)).map((row) => row.id),
      ["ok1", "ok2"],
    );
    assert.ok(
      logs.some((line) => /warning: 1 thread\(s\) skipped .*chat1/u.test(line)),
      logs.join("|"),
    );
    const broken = {
      ...client,
      async fetchThread(): Promise<never> {
        throw new GmailRequestError("Gmail request failed (401 Unauthorized)", 401);
      },
    };
    await assert.rejects(fetchThreadsById(broken, ["never-cached"], context(root, {})), AggregateError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
