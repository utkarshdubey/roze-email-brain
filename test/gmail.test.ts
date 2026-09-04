import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Agent, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTokenSource,
  GMAIL_SCOPE,
  GOOGLE_TOKEN_URI,
  loadSavedCredentials,
  signInWithGoogle,
  type GoogleCredentials,
} from "../src/gmail/auth.js";
import { GmailClient } from "../src/gmail/client.js";
import type { FetchLike } from "../src/gmail/http.js";
import { cleanMessageBody, MAX_BODY_CHARS, parseMessage, type GmailMessageResource } from "../src/gmail/messages.js";
import { mapAtLimitedConcurrency } from "../src/context.js";
import { cleanSnippet } from "../src/shared/text.js";

const credentials: GoogleCredentials = {
  token: "token",
  refresh_token: "refresh",
  token_uri: GOOGLE_TOKEN_URI,
  client_id: "id",
  client_secret: "secret",
  scopes: [GMAIL_SCOPE],
  expiry: "2030-01-01T00:00:00.000Z",
};
function rawMessage(id = "m1", internalDate = "1776172353000"): GmailMessageResource {
  return {
    id,
    threadId: "thread-1",
    internalDate,
    labelIds: ["INBOX"],
    snippet: "snippet",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "Date", value: "Tue, 14 Apr 2026 09:12:33 -0400" },
        { name: "From", value: '"Jane Doe" <JANE@Example.COM>' },
        { name: "Subject", value: "Hello" },
        { name: "List-Id", value: "list.example.com" },
      ],
      parts: [
        { mimeType: "text/html", body: { data: Buffer.from("<p>HTML</p>").toString("base64url") } },
        {
          mimeType: "text/plain",
          body: { data: Buffer.from(" Hello  there\n> old\nOn Tuesday, Jane wrote:\nold").toString("base64url") },
        },
      ],
    },
  };
}

test("messages prefer plain text, preserve sender-local dates, and cap Unicode bodies", () => {
  const parsed = parseMessage(rawMessage());
  assert.deepEqual(
    { date: parsed.date, day: parsed.day, from: parsed.fromEmail, body: parsed.body },
    { date: "2026-04-14T09:12-04:00", day: "2026-04-14", from: "jane@example.com", body: "Hello there" },
  );
  const suffix = " …[truncated]";
  const cleaned = cleanMessageBody(`${"🙂".repeat(MAX_BODY_CHARS)}x`);
  assert.equal(Array.from(cleaned.slice(0, -suffix.length)).length, MAX_BODY_CHARS);
  assert.ok(cleaned.endsWith(suffix));
});

test("client pages ids and parses full threads and metadata", async () => {
  const urls: URL[] = [];
  let now = 1_000;
  const fetcher: FetchLike = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    now += 5;
    if (url.pathname.endsWith("/threads"))
      return Response.json(
        url.searchParams.has("pageToken")
          ? { threads: [{ id: "t3" }] }
          : { threads: [{ id: "t1" }, { id: "t2" }], nextPageToken: "next" },
      );
    if (url.pathname.endsWith("/threads/thread-1"))
      return Response.json({ messages: [rawMessage("new", "2000"), rawMessage("old", "1000")] });
    if (url.pathname.endsWith("/messages/m1")) return Response.json(rawMessage());
    if (url.pathname.endsWith("/profile"))
      return Response.json({ emailAddress: "me@example.com", historyId: "1" });
    throw new Error(`unexpected ${url}`);
  };
  const client = new GmailClient(credentials, { fetch: fetcher, sleep: async () => undefined, now: () => now });
  assert.deepEqual(client.getUsage(), {
    requests: 0,
    quotaUnits: 0,
    byResource: {
      profile: { requests: 0, quotaUnits: 0 },
      lists: { requests: 0, quotaUnits: 0 },
      messages: { requests: 0, quotaUnits: 0 },
      threads: { requests: 0, quotaUnits: 0 },
    },
    unitsPerMinute: 12_750,
    unitsPerMinuteCeiling: 12_750,
    elapsedMs: 0,
  });
  assert.deepEqual(await client.listThreadIds("in:sent"), ["t1", "t2", "t3"]);
  assert.deepEqual(
    (await client.fetchThread("thread-1")).messages.map((row) => row.id),
    ["old", "new"],
  );
  assert.equal((await client.fetchMessageHeaders("m1")).fromEmail, "jane@example.com");
  assert.equal(urls[1]?.searchParams.get("pageToken"), "next");
  const beforeProfile = client.getUsage();
  await client.getProfile();
  assert.equal(beforeProfile.requests, 4, "a returned snapshot is detached from later requests");
  assert.deepEqual(client.getUsage(), {
    requests: 5,
    quotaUnits: 26,
    byResource: {
      profile: { requests: 1, quotaUnits: 1 },
      lists: { requests: 2, quotaUnits: 10 },
      messages: { requests: 1, quotaUnits: 5 },
      threads: { requests: 1, quotaUnits: 10 },
    },
    unitsPerMinute: 12_750,
    unitsPerMinuteCeiling: 12_750,
    elapsedMs: 25,
  });
});

test("a 401 mid-build renews the token once through the source and repeats the request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "roze-token-source-")),
    path = join(directory, ".token.json");
  try {
    writeFileSync(path, JSON.stringify({ ...credentials, expiry: "2030-01-01T00:00:00Z" }));
    const bearers: string[] = [];
    let refreshes = 0;
    const fetcher: FetchLike = async (input, init) => {
      if (String(input) === GOOGLE_TOKEN_URI) {
        refreshes += 1;
        return Response.json({ access_token: `fresh-${refreshes}`, expires_in: 3600 });
      }
      const bearer = String(new Headers(init?.headers).get("authorization"));
      bearers.push(bearer);
      if (bearer === "Bearer token") return new Response("{}", { status: 401, statusText: "Unauthorized" });
      return Response.json({ emailAddress: "me@example.com", historyId: "1" });
    };
    const client = new GmailClient(createTokenSource({ tokenPath: path, fetch: fetcher }), {
      fetch: fetcher,
      sleep: async () => undefined,
    });
    assert.equal((await client.getProfile()).emailAddress, "me@example.com");
    assert.deepEqual(bearers, ["Bearer token", "Bearer fresh-1"], "the stale token is spent once, then renewed");
    assert.equal(client.getUsage().byResource.profile.requests, 2, "both outbound Gmail attempts are counted");
    assert.match(readFileSync(path, "utf8"), /"token": "fresh-1"/u, "the renewed token is saved for the next command");
    // Sixteen workers crossing the boundary together buy one renewal, and a renewed token is spent as-is.
    await Promise.all([client.getProfile(), client.getProfile(), client.getProfile()]);
    assert.equal(refreshes, 1);
    assert.equal(client.getUsage().requests, 5, "the OAuth token request is not a Gmail API request");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("message listings carry thread ids and a single-message thread reads as one message", async () => {
  const urls: URL[] = [];
  const fetcher: FetchLike = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname.endsWith("/messages"))
      return Response.json({ messages: [{ id: "m1", threadId: "thread-1" }, { id: "m2", threadId: "thread-2" }] });
    if (url.pathname.endsWith("/messages/m1")) return Response.json(rawMessage());
    throw new Error(`unexpected ${url}`);
  };
  const client = new GmailClient("token", { fetch: fetcher, sleep: async () => undefined });
  assert.deepEqual(await client.listMessages("newer_than:2y"), [
    { id: "m1", threadId: "thread-1" },
    { id: "m2", threadId: "thread-2" },
  ]);
  const thread = await client.fetchSingleMessageThread("m1", "thread-1");
  assert.equal(thread.id, "thread-1");
  assert.deepEqual(
    thread.messages.map((row) => row.id),
    ["m1"],
  );
  assert.equal(urls.at(-1)?.searchParams.get("format"), "full");
});

test("a quota 403 teaches the client its real minute cap and the window waits instead of a full stop", async () => {
  let calls = 0;
  let clock = 1_000_000;
  const delays: number[] = [];
  const client = new GmailClient("token", {
    now: () => clock,
    sleep: async (ms) => {
      delays.push(ms);
      clock += ms;
    },
    fetch: async () => {
      calls += 1;
      if (calls === 1)
        return new Response('{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}', {
          status: 403,
          statusText: "Forbidden",
        });
      return Response.json({ emailAddress: "me@example.com", historyId: "1" });
    },
  });
  const fullCap = client.unitsPerMinute;
  assert.equal((await client.getProfile()).emailAddress, "me@example.com");
  assert.equal(calls, 2);
  assert.ok(
    delays.every((ms) => ms < 10_000),
    `a quota answer costs seconds, not the old 61 s full stop: ${delays.join(", ")}`,
  );
  // One profile unit was in the window when Gmail refused, so the learned cap is the floor, not the ceiling.
  assert.ok(client.unitsPerMinute < fullCap / 3, `the cap was learned from the window: ${client.unitsPerMinute}`);
  await Promise.all([client.getProfile(), client.getProfile()]);
  assert.deepEqual(
    { requests: client.getUsage().requests, quotaUnits: client.getUsage().quotaUnits },
    { requests: 4, quotaUnits: 4 },
    "the retried quota answer and the three successful attempts all spend profile units",
  );
  assert.ok(
    delays.some((ms) => ms > 0 && ms < 5_000),
    "request spacing",
  );
  // Requests are now spaced to spend the learned cap evenly across a minute: no burst, no stall.
  const before = delays.length;
  for (let index = 0; index < 20; index += 1) await client.getProfile();
  const spacing = delays.slice(before).filter((ms) => ms > 0);
  const expected = 60_000 / client.unitsPerMinute;
  assert.ok(
    spacing.length >= 19 && spacing.every((ms) => Math.abs(ms - expected) < 1),
    `each unit is spaced at 60 s / cap (${expected.toFixed(1)} ms): ${spacing.slice(0, 5).join(", ")}`,
  );
});

test("usage counts a transport failure when fetch was invoked", async () => {
  let attempts = 0;
  let now = 100;
  const client = new GmailClient("token", {
    now: () => now,
    sleep: async () => undefined,
    fetch: async () => {
      attempts += 1;
      now += 4;
      if (attempts === 1) throw new Error("socket closed");
      return Response.json({ emailAddress: "me@example.com", historyId: "1" });
    },
  });
  assert.equal(client.getUsage().elapsedMs, 0);
  assert.equal((await client.getProfile()).emailAddress, "me@example.com");
  assert.deepEqual(client.getUsage(), {
    requests: 2,
    quotaUnits: 2,
    byResource: {
      profile: { requests: 2, quotaUnits: 2 },
      lists: { requests: 0, quotaUnits: 0 },
      messages: { requests: 0, quotaUnits: 0 },
      threads: { requests: 0, quotaUnits: 0 },
    },
    unitsPerMinute: 12_750,
    unitsPerMinuteCeiling: 12_750,
    elapsedMs: 8,
  });
});

test("limited concurrency preserves order and finishes siblings before throwing", async () => {
  const visited: number[] = [];
  await assert.rejects(
    mapAtLimitedConcurrency([0, 1, 2], 2, async (item) => {
      visited.push(item);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (item === 1) throw new Error("bad item");
      return item * 10;
    }),
    AggregateError,
  );
  assert.deepEqual(visited.sort(), [0, 1, 2]);
  assert.deepEqual(await mapAtLimitedConcurrency([3, 1], 2, async (item) => item * 10), [30, 10]);
});

test("expired credentials refresh through the token endpoint and remain mode 0600", async () => {
  const directory = mkdtempSync(join(tmpdir(), "roze-oauth-"));
  const path = join(directory, ".token.json");
  try {
    writeFileSync(path, JSON.stringify({ ...credentials, expiry: "2020-01-01T00:00:00Z" }));
    const fetcher: FetchLike = async (input, init) => {
      assert.equal(String(input), GOOGLE_TOKEN_URI);
      assert.match(String(init?.body), /grant_type=refresh_token/u);
      return Response.json({ access_token: "fresh", expires_in: 3600 });
    };
    const loaded = await loadSavedCredentials({
      tokenPath: path,
      fetch: fetcher,
      now: () => Date.parse("2026-01-01T00:00:00Z"),
    });
    assert.equal(loaded.token, "fresh");
    assert.match(readFileSync(path, "utf8"), /"token": "fresh"/u);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("snippets lose invisible padding characters", () => {
  assert.equal(cleanSnippet("\u034f \u034f \u200b Your order  total\u00ad: $15.02 \u034f"), "Your order total: $15.02");
});

test("sign-in releases the callback server even while the browser holds a keep-alive connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roze-auth-"));
  const previous = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
  process.env.GOOGLE_CLIENT_ID = "client";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  const keepAlive = new Agent({ keepAlive: true });
  let port = 0;
  try {
    const credentials = await signInWithGoogle({
      tokenPath: join(dir, "token.json"),
      timeoutMs: 60_000,
      openBrowser: (url) => {
        const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
        redirect.searchParams.set("state", new URL(url).searchParams.get("state")!);
        redirect.searchParams.set("code", "auth-code");
        port = Number(redirect.port);
        // The browser follows Google's redirect back to us and keeps the socket open afterwards.
        httpRequest(redirect, { agent: keepAlive }, (response) => response.resume()).end();
      },
      fetch: async () => Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
    });
    assert.equal(credentials.refresh_token, "refresh");
    const refused = await new Promise<boolean>((done) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("error", () => done(true));
      socket.once("connect", () => {
        socket.destroy();
        done(false);
      });
    });
    assert.ok(refused, "the callback server must be closed once the code arrived, keep-alive or not");
  } finally {
    keepAlive.destroy();
    process.env.GOOGLE_CLIENT_ID = previous.id;
    process.env.GOOGLE_CLIENT_SECRET = previous.secret;
    rmSync(dir, { recursive: true, force: true });
  }
});
