import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProviderRequest, ProviderResult } from "../src/llm/provider.js";
import { answerOneQuestion, type CreateResponse } from "../src/query/answerAgent.js";
import { auditCitations } from "../src/query/citations.js";
import { executeTool, readEmail, readMemory } from "../src/query/memoryTools.js";
import { searchMemory } from "../src/query/memorySearch.js";
import { TOOL_DEFINITIONS } from "../src/query/toolContracts.js";
import { readOnDemandThreadIds } from "../src/ingest/cache.js";
import { resolveBrainPaths } from "../src/brain/storage.js";
import { thread } from "./helpers.js";

function brain(): { parent: string; root: string } {
  const parent = mkdtempSync(join(tmpdir(), "roze-query-"));
  const root = join(parent, "brain");
  for (const path of ["people", "threads", "evidence/threads", "projects", "interests", "organizations", "open_loops"])
    mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "INDEX.md"), "# Brain\n");
  writeFileSync(join(root, "people", "INDEX.md"), "# Entities\n- Alice Example\n");
  writeFileSync(
    join(root, "people", "alice.md"),
    "# Alice Example\nWorks on Project Blue. [t:abcdef1234567890 2026-08-28]\n",
  );
  writeFileSync(
    join(root, "evidence", "threads", "abcdef1234567890.md"),
    "# Blue\nthread: abcdef1234567890\n\n## 2026-08-28T09:00-04:00  from: alice@example.com\n\nProject Blue update.\n",
  );
  return { parent, root };
}
const usage = { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4, reasoningTokens: 1 };
const searchArgs = (query: string, scope: string, match = "all_terms"): string =>
  JSON.stringify({ query, scope, match, limit: 5, group_by: "none", amounts: "ignore", from: "", to: "" });
function response(calls: ProviderResult["functionCalls"] = [], outputText = ""): ProviderResult {
  return {
    outputText,
    status: "completed",
    incompleteReason: "",
    functionCalls: calls,
    outputItems: calls.map((call) => ({
      type: "function_call",
      call_id: call.callId,
      name: call.name,
      arguments: call.argumentsJson,
    })),
    usage,
  };
}

test("tool definitions come from strict Zod shapes and the allowlist rejects every escape route", async () => {
  const { parent, root } = brain();
  try {
    assert.deepEqual(
      TOOL_DEFINITIONS.map((tool) => tool.name),
      ["search_memory", "read_memory", "read_email"],
    );
    assert.equal(TOOL_DEFINITIONS[0]?.parameters.additionalProperties, false);
    const outside = join(parent, "outside.md");
    writeFileSync(outside, "OUTSIDE-SECRET\n");
    writeFileSync(join(root, "people", ".hidden.md"), "DOT-SECRET\n");
    mkdirSync(join(root, ".cache"));
    writeFileSync(join(root, ".cache", "secret.md"), "CACHE-SECRET\n");
    writeFileSync(join(root, "people", "rows.jsonl"), "JSONL-SECRET\n");
    symlinkSync(outside, join(root, "people", "linked.md"));
    assert.match(
      await executeTool("read_memory", { path: "evidence/threads/2026.md", start_line: 1, max_lines: 5 }, root),
      /raw threads are evidence\/threads\/<16-hex thread id>\.md/u,
    );
    const rejected = [
      outside,
      "../outside.md",
      "people/../../outside.md",
      "people/.hidden.md",
      ".cache/secret.md",
      "people/rows.jsonl",
      "people/linked.md",
    ];
    for (const path of rejected) {
      const result = await executeTool("read_memory", { path, start_line: 1, max_lines: 20 }, root);
      assert.match(result, /^error:/u, path);
      assert.doesNotMatch(result, /OUTSIDE-SECRET|DOT-SECRET|CACHE-SECRET|JSONL-SECRET/u);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("search is literal and line reads use one-based inclusive ranges", () => {
  const { parent, root } = brain();
  try {
    writeFileSync(join(root, "people", "literal.md"), "A+B is literal.\none\ntwo\nthree\n");
    assert.match(searchMemory(root, "a+b", "people", "all_terms", 5), /A\+B is literal/u);
    assert.equal(
      readMemory(root, "people/literal.md", 2, 2),
      "people/literal.md [lines 2-3 of 4]\n    2 | one\n    3 | two",
    );
    writeFileSync(
      join(root, "evidence", "threads", "abcdef1234567891.md"),
      Array.from(
        { length: 400 },
        (_, index) => `## 2026-01-${String(1 + (index % 28)).padStart(2, "0")}T09:00Z line ${index} ${"x".repeat(80)}`,
      ).join("\n"),
    );
    const long = readMemory(root, "evidence/threads/abcdef1234567891.md", 1, 500);
    assert.ok(long.length <= 24_500 && long.length > 20_000, `long reads stop near the cap: ${long.length}`);
    assert.match(
      long,
      /\[read stops at line \d+ of 400; call read_memory with start_line=\d+ to continue through the final message\]$/u,
    );
    writeFileSync(
      join(root, "threads", "threads-2019.md"),
      "- 2019-03-01 Known: call with David about backend. [t:a1 2019-03-01]\n",
    );
    writeFileSync(
      join(root, "threads", "threads-2026.md"),
      "- 2026-06-02 Known: call with David about backend. [t:a2 2026-06-02]\n",
    );
    assert.match(
      searchMemory(root, "Known David", "thread_summaries", "all_terms", 5).split("\n")[1] ?? "",
      /threads-2026\.md/u,
      "newer rows rank first at equal relevance",
    );
    // Twelve matching rows, newest first, and the exact phrase only on the oldest: the per-file share is
    // taken after ranking, so the old row is the first result instead of being dropped unread.
    writeFileSync(
      join(root, "threads", "threads-2020.md"),
      [
        ...Array.from(
          { length: 11 },
          (_, index) => `- 2020-12-${String(20 - index).padStart(2, "0")} Rox vendor invoice noted. [t:b${index} 2020-12-01]`,
        ),
        "- 2020-01-05 Vendor sent the Rox onboarding invoice, paid. [t:b99 2020-01-05]",
      ].join("\n") + "\n",
    );
    const needle = searchMemory(root, "Rox onboarding invoice", "thread_summaries", "any_term", 5);
    assert.match(needle.split("\n")[1] ?? "", /threads-2020\.md:12/u, "the best row wins, not the first ten");
    assert.match(needle, /^5 of \d+ matches/u);
    mkdirSync(join(root, "evidence"), { recursive: true });
    writeFileSync(
      join(root, "evidence", "inbox-2026.md"),
      [
        "# Skim",
        "",
        ...Array.from(
          { length: 12 },
          (_, i) =>
            `a${String(i).padStart(15, "0")} | 2026-0${1 + (i % 6)}-1${i % 9} | no-reply@doordash.com | auto | 1 msgs | Order Confirmation for Sean from Tacoria | Your order`,
        ),
        ...Array.from(
          { length: 4 },
          (_, i) =>
            `b${String(i).padStart(15, "0")} | 2026-07-0${1 + i} | no-reply@doordash.com | auto | 1 msgs | Re: Order Confirmation for Sean from Clove Garden | Your order`,
        ),
        "c000000000000000 | 2026-08-30 | promo@doordash.com | auto | 1 msgs | DashPass deals | Save",
      ].join("\n"),
    );
    const tally = searchMemory(root, "doordash order confirmation", "thread_summaries", "all_terms", 10, "subject");
    assert.match(
      tally,
      /^16 matching threads for 'doordash order confirmation' in thread_summaries, 2 distinct subjects/u,
    );
    assert.match(
      tally,
      /\n12 \| order confirmation for sean from tacoria \| \[t:a\d+ 2026-0\d-\d\d\]\n4 \| order confirmation for sean from clove garden \| \[t:b000000000000003 2026-07-04\]$/u,
      tally,
    );
    assert.match(
      searchMemory(root, "doordash", "thread_summaries", "any_term", 5, "sender"),
      /^17 matching threads .*2 distinct senders/u,
    );
    writeFileSync(
      join(root, "evidence", "transactions-2026.md"),
      [
        "# Transactions",
        "",
        ...Array.from(
          { length: 12 },
          (_, i) =>
            `a${String(i).padStart(15, "0")} | 2026-0${1 + (i % 6)}-1${i % 9} | Tacoria | order | ${(10 + i).toFixed(2)} | USD | no-reply@doordash.com | Order Confirmation for Sean from Tacoria`,
        ),
        "b000000000000000 | 2026-07-01 | Clove Garden | order | 31.50 | USD | no-reply@doordash.com | Order Confirmation for Sean from Clove Garden",
      ].join("\n"),
    );
    const spend = searchMemory(root, "doordash", "transactions", "all_terms", 10, "merchant", "sum");
    assert.match(
      spend,
      /^13 matching threads for 'doordash' in transactions; 13 carry a stated total summing to \$217\.50 \(0 without an amount\)/u,
      spend,
    );
    assert.match(spend, /\n12 \| \$186\.00 \| tacoria \| /u);
    assert.match(spend, /\n1 \| \$31\.50 \| clove garden \| /u);
    assert.match(
      searchMemory(root, "order", "transactions", "all_terms", 5, "kind"),
      /^13 matching threads .*\n13 \| order \| /u,
    );
    const week = searchMemory(
      root,
      "doordash",
      "transactions",
      "all_terms",
      5,
      "month",
      "sum",
      "2026-02-01",
      "2026-03-31",
    );
    assert.match(
      week,
      /^4 matching threads for 'doordash' between 2026-02-01 and 2026-03-31 in transactions; 4 carry a stated total summing to \$/u,
      "the harness filters the period and sums it",
    );
    writeFileSync(
      join(root, "threads", "threads-2026.md"),
      "- summary rows\na000000000000000 | 2026-01-10 → 2026-01-10 | none | Order confirmation from DoorDash for Sean: Tacoria order\n",
    );
    assert.match(
      searchMemory(root, "doordash order confirmation", "thread_summaries", "all_terms", 10, "subject"),
      /^16 matching threads/u,
      "a thread listed in both threads/ and evidence/ is counted once",
    );
    assert.deepEqual(
      auditCitations(
        "Tacoria 12 times [t:b000000000000003 2026-07-04]",
        root,
        new Set(),
        new Set(["b000000000000003 2026-07-04"]),
      ),
      { unread: [], invalid: [], missing: [] },
      "tally example rows are grounded citations",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the agent executes no more than the cap, keeps tools declared, then answers from prior output", async () => {
  const { parent, root } = brain();
  try {
    const requests: ProviderRequest[] = [];
    const calls = [
      {
        callId: "one",
        name: "read_memory",
        argumentsJson: JSON.stringify({ path: "people/alice.md", start_line: 1, max_lines: 20 }),
      },
      {
        callId: "two",
        name: "read_memory",
        argumentsJson: JSON.stringify({ path: "people/INDEX.md", start_line: 1, max_lines: 20 }),
      },
    ];
    const create: CreateResponse = async (request) => {
      requests.push(request);
      return requests.length === 1
        ? response(calls)
        : response([], "Alice works on Project Blue. [t:abcdef1234567890 2026-08-28]");
    };
    const result = await answerOneQuestion("Who is Alice?", { root, cap: 1, maxCalls: 1, today: "2026-09-02" }, create);
    assert.equal(result.toolCalls.length, 1);
    assert.deepEqual(result.cited, ["abcdef1234567890"]);
    assert.equal(requests[1]?.toolChoice, "none");
    assert.equal(requests[1]?.tools?.length, 3);
    assert.match(
      JSON.stringify(requests[1]?.input),
      /Answer now in prose with citations using only outputs already read/u,
    );
    assert.match(JSON.stringify(requests[1]?.input), /tool-call cap reached/u);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("read_email serves cached threads, fetches uncached ones live once, and remembers them for generate", async () => {
  const { parent, root } = brain();
  try {
    const live = thread("abcdef1234567890", ["2026-08-28"], ["bob@example.com"]);
    let fetched = 0;
    const access = async (id: string) => {
      fetched += 1;
      return { ...live, id };
    };
    assert.match(await readEmail(root, "abcdef1234567890", undefined), /^error: live Gmail access is unavailable/u);
    const first = await readEmail(root, "abcdef1234567890", access);
    assert.match(first, /^# Example\nthread: abcdef1234567890/u);
    assert.match(first, /RAW BODY: useful update/u);
    assert.equal(await readEmail(root, "abcdef1234567890", undefined), first, "second read comes from the cache");
    assert.equal(fetched, 1);
    assert.deepEqual(readOnDemandThreadIds(resolveBrainPaths(root)), ["abcdef1234567890"]);
    assert.deepEqual(
      auditCitations("x [t:abcdef1234567890 2026-08-28]", root, new Set(["abcdef1234567890"])),
      { unread: [], invalid: [], missing: [] },
      "a live-read thread counts as present for the audit",
    );
    writeFileSync(join(root, "meta.json"), JSON.stringify({ userEmail: "owner@example.com" }));
    const scoped = await readEmail(root, "abcdef1234567891", async (id) => ({ ...live, id }));
    assert.match(scoped, /^# Example/u);
    assert.deepEqual(
      auditCitations("y [t:abcdef1234567891 2026-08-28]", root, new Set(["abcdef1234567891"])),
      { unread: [], invalid: [], missing: [] },
      "and under the account namespace too",
    );
    assert.match(await executeTool("read_email", { thread_id: "../etc" }, root, access), /^error:/u);
    assert.match(await executeTool("read_email", { thread_id: "ABCDEF" }, root, access), /^error:/u);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("citations must name threads the agent opened; one verification round repairs, otherwise the answer is flagged", async () => {
  const { parent, root } = brain();
  try {
    assert.deepEqual(
      auditCitations(
        "x [t:abcdef1234567890 2026-08-28] [t:abcdef1234567890 2026-08-29] [t:ffffffffffff 2026-08-28]",
        root,
        new Set(),
      ),
      {
        unread: ["abcdef1234567890 2026-08-28"],
        invalid: ["abcdef1234567890 2026-08-29"],
        missing: ["ffffffffffff 2026-08-28"],
      },
    );
    assert.deepEqual(auditCitations("x [t:abcdef1234567890 2026-08-28]", root, new Set(["abcdef1234567890"])), {
      unread: [],
      invalid: [],
      missing: [],
    });
    let requests: ProviderRequest[] = [];
    const draft = "Alice works on Blue. [t:abcdef1234567890 2026-08-28]";
    const repairing: CreateResponse = async (request) => {
      requests.push(request);
      if (requests.length === 1)
        return response([
          {
            callId: "s",
            name: "search_memory",
            argumentsJson: searchArgs("Alice", "people"),
          },
        ]);
      if (requests.length === 2) return response([], draft);
      if (requests.length === 3)
        return response([
          {
            callId: "r",
            name: "read_memory",
            argumentsJson: JSON.stringify({
              path: "evidence/threads/abcdef1234567890.md",
              start_line: 1,
              max_lines: 50,
            }),
          },
        ]);
      return response([], draft);
    };
    const repaired = await answerOneQuestion("Who is Alice?", { root, cap: 2, today: "2026-09-02" }, repairing);
    assert.equal(repaired.answer, draft);
    assert.deepEqual(repaired.unverified, []);
    assert.equal(repaired.toolCalls.length, 2);
    assert.deepEqual(
      { read: repaired.readThreads, draft: repaired.draftAudit, round: repaired.verificationRound },
      { read: ["abcdef1234567890"], draft: ["abcdef1234567890 2026-08-28"], round: true },
    );
    assert.match(
      JSON.stringify(requests[2]?.input),
      /Grounding check failed \(cited without reading the thread: abcdef1234567890 2026-08-28\)/u,
    );
    requests = [];
    const stubborn: CreateResponse = async (request) => {
      requests.push(request);
      return response([], draft);
    };
    const flagged = await answerOneQuestion("Who is Alice?", { root, cap: 2, today: "2026-09-02" }, stubborn);
    assert.equal(requests.length, 2);
    assert.deepEqual(flagged.unverified, ["abcdef1234567890 2026-08-28"]);
    assert.match(
      flagged.answer,
      /\[Grounding warning — cited without reading the thread: abcdef1234567890 2026-08-28\. Treat those claims as unverified\.\]$/u,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an absence claim must first read the header-only rows its own search surfaced", async () => {
  const { parent, root } = brain();
  try {
    mkdirSync(join(root, "evidence"), { recursive: true });
    writeFileSync(
      join(root, "evidence", "inbox-2026.md"),
      "# Skim\n\nfeedfeedfeedfeed | 2026-08-30 | promo@shop.example | auto | 1 msgs | Sprint PCS online benefits | Free shipping and a $20 credit\n",
    );
    const requests: ProviderRequest[] = [];
    const live = { ...thread("feedfeedfeedfeed", ["2026-08-30"], ["promo@shop.example"]) };
    live.messages[0]!.body = "Shop online: free shipping and a $20 credit.";
    const create: CreateResponse = async (request) => {
      requests.push(request);
      if (requests.length === 1)
        return response([
          {
            callId: "s",
            name: "search_memory",
            argumentsJson: searchArgs("Sprint benefits", "all", "any_term"),
          },
        ]);
      if (requests.length === 2) return response([], "Nothing in your email lists the Sprint benefits.");
      if (requests.length === 3)
        return response([
          { callId: "e", name: "read_email", argumentsJson: JSON.stringify({ thread_id: "feedfeedfeedfeed" }) },
        ]);
      return response([], "Free shipping and a $20 credit. [t:feedfeedfeedfeed 2026-08-30]");
    };
    const result = await answerOneQuestion(
      "What are the Sprint benefits?",
      { root, cap: 2, today: "2026-09-02", fetchThread: async (id) => ({ ...live, id }) },
      create,
    );
    assert.equal(result.headerRound, true);
    assert.match(JSON.stringify(requests[2]?.input), /header-only inbox rows you have not read \(feedfeedfeedfeed\)/u);
    assert.deepEqual(
      { cited: result.cited, unverified: result.unverified, tools: result.toolCalls.map((call) => call.tool) },
      { cited: ["feedfeedfeedfeed"], unverified: [], tools: ["search_memory", "read_email"] },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the tool budget extends while calls keep opening new material, and citations copied from read views are grounded", async () => {
  const { parent, root } = brain();
  try {
    for (let i = 0; i < 6; i += 1)
      writeFileSync(
        join(root, "people", `person-${i}.md`),
        `# Person ${i}\n- 2026-0${i + 1}-01 Met about topic ${i}. [t:cafe${String(i).padStart(12, "0")} 2026-0${i + 1}-01]\n`,
      );
    const requests: ProviderRequest[] = [];
    const reads = (n: number) =>
      response(
        Array.from({ length: n }, (_, i) => ({
          callId: `r${requests.length}-${i}`,
          name: "read_memory",
          argumentsJson: JSON.stringify({
            path: `people/person-${(requests.length - 1) * 2 + i}.md`,
            start_line: 1,
            max_lines: 20,
          }),
        })),
      );
    const create: CreateResponse = async (request) => {
      requests.push(request);
      if (requests.length <= 3) return reads(2);
      return response(
        [],
        "Six people: " +
          Array.from({ length: 6 }, (_, i) => `[t:cafe${String(i).padStart(12, "0")} 2026-0${i + 1}-01]`).join(" "),
      );
    };
    const result = await answerOneQuestion(
      "List six people",
      { root, cap: 2, maxCalls: 10, today: "2026-09-02" },
      create,
    );
    assert.equal(result.extensions, 1, "the first window opened new profiles, so the budget grew once to the ceiling");
    assert.equal(result.toolCalls.length, 6);
    assert.deepEqual(result.unverified, [], "citations copied from read profiles need no raw-thread read");
    assert.match(JSON.stringify(requests[2]?.input), /Budget extended/u);

    const stubbornRequests: ProviderRequest[] = [];
    const repeat: CreateResponse = async (request) => {
      stubbornRequests.push(request);
      if (stubbornRequests.length <= 2)
        return response([
          {
            callId: `s${stubbornRequests.length}`,
            name: "search_memory",
            argumentsJson: searchArgs("nobody", "people"),
          },
        ]);
      return response([], "Nothing in your email about that.");
    };
    const stalled = await answerOneQuestion(
      "Who is nobody?",
      { root, cap: 1, maxCalls: 10, today: "2026-09-02" },
      repeat,
    );
    assert.equal(stalled.extensions, 0, "a window that opened nothing new does not extend");
    assert.equal(stalled.toolCalls.length, 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
