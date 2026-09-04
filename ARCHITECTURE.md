# Architecture

`roze-email` is a Node 20+, strict-TypeScript ESM CLI. It has three commands, three runtime
dependencies (`zod`, `@clack/prompts`, `picocolors`), one provider adapter, one generation context,
and a plain-file output.

## Public commands

`src/cli.ts` dispatches exactly `auth`, `generate`, and `prompt`; each lives in `src/commands/`.

- `auth` performs loopback Google OAuth with `gmail.readonly`, verifies the profile, and saves an
  owner-only token. Later commands spend it through a token source that renews it a few minutes
  before expiry and once more after a 401, so a build longer than an access token's hour survives.
  Without a `GOOGLE_CLIENT_SECRET` in `.env`, the code exchange and every refresh go through a small
  token proxy (`ROZE_TOKEN_PROXY`, baked-in default) that holds the secret; with one they go to Google.
- `generate` reads Gmail, derives memory, renders a complete staging tree, then swaps it into place.
- `prompt <query>` answers once through three read-only tools and audits the resulting citations.

## Generation

`src/commands/generate.ts` owns the flags, usage summaries, and injectable seams;
`src/generation/buildBrain.ts` is the orchestration root, and `src/generation/phases.ts` owns the phase
plan and the mid-build status.
Every generation stage receives its data and a `PipelineContext` containing resolved paths, today's
day, progress logging, and the model function.

```text
Gmail
  → select/cache threads and inbox headers
  → promote selected inbox senders
  → extract full-read threads
  ├→ resolve people, organizations, and open loops
  ├→ render raw evidence, transactions, and thread summaries
  └→ cards → domain/topic tags → entity/domain/topic clusters → judge → gates
           → whole-list review (+ loops and recurring merchants) → gates
           → related-thread search → project, interest, and proposal-trace files
  → render root metadata → stage → atomic swap
```

The command publishes these phases in order:

1. `full-read`: every sent, starred, or previously fetched-on-demand thread is fetched in full and
   extracted. The fast inbox header request overlaps this model-bound extraction.
2. `fast-inbox`: a newest-first recent-window header sample (24 months by default) excludes obvious
   automated senders and learns consistently automated bulk domains. A model chooses useful senders to promote.
3. `complete-inbox`: every eligible thread in that window is indexed, including automated senders; newly
   promoted threads are fetched and extracted. The backfill lists the window's messages once (which
   says how many each thread has) and reads each thread the fast pass never covered: a single-message
   thread as one message (5 quota units), a longer one in full (10), never a metadata header first,
   so the body phase finds it already cached and no skim thread is ever fetched twice. Its index row
   is derived from the thread's first message, in the same fields a metadata read would have produced.
4. `body-evidence`: raw bodies for every remaining indexed thread are fetched and stored, but never
   extracted. Sender engagement orders uncached ids before recency and id, so a stopped build caches useful
   mail first. This costs Gmail time, not model tokens.
5. `concepts`: cards, tags, clusters, judge, and the first gates run while phase 4 downloads bodies;
   the whole-list review, its gates, and the related-thread search run once both finish, because
   receipts found in body-only mail feed the recurring-interest review.

Every enabled phase renders a complete brain. `--recent <months>` changes only the skim tiers; participated,
starred, and on-demand mail stay all-time, while metadata and index headings record the boundary.
`--publish-once` skips only the intermediate swaps, not the work or order. `--no-skim` removes phases 2–4;
`--no-synthesize` removes phase 5;
`--no-promote` keeps the inbox index and bodies but skips sender judgment and extraction.

`src/brain/storage.ts` owns published/cache paths, retrieval scopes, and publication. It stages
targets beside the live tree, renames every target, and rolls back a partial failure; caches remain
outside the swap. Rename retries exist because Windows scanners and sync clients can hold files open.
After each successful publication, generation removes the account's derived search index so the next
query rebuilds it against the new tree.

## Ingestion and memory

`src/ingest/mail.ts` owns selection, recent-window queries, resumable fetches, and deterministic ordering
over the account cache in `ingest/cache.ts`; `ingest/engagement.ts` reduces Gmail labels and participation
to a per-sender score. `ingest/promote.ts` owns sender promotion. Promotion groups headers by sender and
includes opened, replied, important, and starred counts; its strict response chooses `all`, `recent`,
`latest`, or `ignore`. Local limits cap those choices at 25, 5 within 180 days, and 1, and automated senders
cannot receive `all`. The Gmail client paces requests under a per-minute unit cap it learns from Gmail's
own quota answers (a sliding window, never a full stop), retries bounded network, 429, 5xx, and
quota-related 403 failures, and counts each outbound attempt and its quota units by resource.

`src/memory/extractThread.ts` makes one structured extraction per full-read thread. Participated
threads can yield eight items; inbox-only promoted threads expose 1,500 body characters and can
yield four. Dates are checked later against real message days. `resolveEntities.ts` owns
conservative identity resolution and fact filing, `openLoops.ts` loop materiality/closure/staleness,
and `transactions.ts`/`recurringMerchants.ts` the typed receipt rows; the `brain/render*.ts` modules
own their published views.

The user's historical UTC offsets are inferred from sent messages in `shared/dates.ts` and
applied at cache boundaries. Raw headings, indexes, transactions, and citations therefore use the
same local day even when the sender used another zone.

## Concepts

`src/concepts/buildConcepts.ts` contains the complete cross-thread order:

1. `makeThreadCards` in `buildConcepts.ts` projects extractions into bounded, body-free cards.
   Omitting bodies limits both prompt size and prompt-injection exposure.
2. `tagLifeDomains.ts` assigns up to three closed-taxonomy labels.
3. `buildClusters.ts` groups recurring entities, life domains, and normalized topics locally. Topic groups
   use subject vocabulary and merge at token-set Jaccard ≥ 0.5. Oversized clusters split by year before
   judgment; entity clusters at or below their cap retain their old keys.
4. `judgeClusters.ts` proposes projects and interests. Its schema permits only exact
   `<thread-id>::<message-day>` references present in that request, and code rejects evidence outside
   the producing cluster. Entity and domain clusters retain the original 24 hash buckets; topics use a
   separate eight-bucket namespace so their addition does not invalidate old request bytes.
5. `applyGates.ts` enforces provenance, recurrence, duration, lifecycle, grounded names, and duplicate
   collapse: the project rules in `projectGates.ts`, the interest rules in `interestGates.ts`, the
   shared grounding index in `evidenceContext.ts`, and cross-cluster collapse in `dedupeConcepts.ts`.
   Every failure increments a named counter.
6. `reviewConcepts.ts` sees the accepted lists whole (its prompts, tables, and response schemas live in
   `reviewRequests.ts`): projects with open loops, interests with recurring
   merchants parsed from transaction evidence in `memory/transactions.ts`. It can merge, form umbrella
   tracks, demote/drop with enumerated reasons, and narrate. References remain enum-bound to members
   and named context.
7. The same gates run again. `buildConcepts.ts` then performs a literal whole-name search over every
   stored thread so concept pages can lead the agent beyond their cited rows.
8. `conceptTrace.ts` follows every raw proposal through both gate passes, both dedupe passes, and review.
   `renderConcepts.ts` publishes the structured rows in `concepts.json` and the newest-stage-first
   `concepts/TRACE.md`, including the final file or exact drop stage.

The review never silently replaces unmentioned concepts. Its merge/demotion log and all gate counts
are published in `concepts.json`; trace bookkeeping does not change either accepted lists or counters.

## Query and grounding

`src/query/answerAgent.ts` runs a bounded Responses tool loop:

```text
question → search_memory | read_memory | read_email → draft → citation audit → answer
```

`src/query/toolContracts.ts` holds the three strict Zod contracts and the output bounds,
`src/query/searchIndex.ts` the account-scoped FTS5 index and BM25 ranking, and
`src/query/memorySearch.ts` the engine dispatch, literal reference scanner, and grouped counting.
`src/query/memoryTools.ts` owns line reads, the live thread read, and dispatch;
`src/query/memoryPaths.ts` is the path allowlist and `src/query/citations.ts` the grounding audit.
Absolute paths, traversal, symlinks, dotfiles, caches, JSONL, and non-generated file types are
rejected. `read_email` is reserved for indexed header-only mail; its handler caches the thread and
records it for extraction on the next generate.

Ranked searches use one FTS5 row per allowlisted Markdown line with the `porter unicode61` tokenizer.
The stored file/day/kind/person metadata combines BM25 with the existing phrase, inbox-person, and
recency bonuses before the existing per-file share and result limit. User fragments are always bound
as quoted MATCH parameters, and scope predicates come only from `VIEW_GLOBS_BY_SCOPE`. The database
lives at `.cache/<account>/search.sqlite`; a fingerprint of `meta.json`'s generation day and the
published file paths, sizes, and mtimes triggers an atomic rebuild. Node versions without `node:sqlite`
and failed builds fall back to the literal scanner; `ROZE_SEARCH=literal` selects it explicitly.

Grouped search counts each matching thread once across yearly indexes and can group by subject,
sender, merchant, kind, currency, day, month, or year; transaction totals can also be summed. This is
the deterministic path for count and frequency questions.

Every `[t:<id> <day>]` is grounded only when it appeared in a view or tally the agent read, or the
agent opened that raw thread and the cited day is one of its message headings. One repair round grants
at most four reads. An absence claim gets one analogous round for unread header rows found by its own
searches; a remaining failure receives a visible warning.

The initial tool cap defaults to 12. It grows by eight while each window opens new material, up to
48 calls and one dollar. Repeated work stops extension. At the cap, tools stay declared but tool
choice becomes `none`, preserving the prompt prefix while forcing an answer from existing output.

## Terminal output

`src/tui.ts` is the only thing that writes to the terminal. Plain mode (no TTY, `--quiet`, `NO_COLOR`,
`ROZE_PLAIN`) is one newline-terminated line per message and one `\r`-redrawn bar per stage. Rich mode
draws a **status board**: a single renderer that owns a block of lines, keeps one row per live stage
(label, bar, `done/total`, elapsed), repaints the whole block in place with cursor-up plus erase-line
at most every 80 ms, and always repaints when a stage finishes. A finished stage leaves the block and
prints one dim `label done/total in Ns` line above it, so the history stays readable.

Stages overlap by design — the Gmail-bound participated-thread fetch runs while the model-bound inbox
skim runs, and later phases extract while other stages report — so the board is a hard invariant:
every terminal write in rich mode goes through it, and no second cursor-owning widget may exist while
a stage is live. `@clack/prompts` bars are spinners that redraw relative to wherever the cursor
stands, on their own interval; two of them corrupted phase 1 (one bar, both counters stacked at its
right edge, the second label lost). clack's intro/outro/spinner survive only for the non-concurrent
moments and only when `board.live` is false. `info`, `step`, `warn`, `error`, `cost`, and `summary`
are handed to the board, which retracts the block, writes the line, and repaints below it, so text can
never land inside a row. A render that faults never throws: rich rendering is dropped and the rest of
the run degrades to plain lines. `createPipelineLog` still gives a stage that reappears with a new
total a fresh row, so a later phase never inherits an earlier phase's geometry.

At the end of `generate`, the model ledger is followed by one Gmail line with total quota units, request
count, thread/message/list attempts, and the elapsed Gmail span. Retries count because Gmail received them.

## Model, cache, and cost boundary

Stage files own their prompt, strict Zod schema, request construction, and result mapping.
`src/llm/models.ts` is the single model boundary: model defaults, prices, usage, budgets, cache
validation and quarantine, atomic cache writes, the shared 5,000-call ceiling, and one low-effort retry
when a reasoning response exhausts its output cap without text. `src/llm/provider.ts` underneath is the
OpenAI Responses adapter and the only code that speaks HTTP to a model.

Every structured model response uses this path:

```text
<request.cacheDir>/<kind>.<sha256(
  "model-call-v1\0" + model + system_prompt + user_input
)>.json
```

The schema and request kind are intentionally not part of the hash. Extraction uses the same formula:
its system input includes the account and the thread's own last message day, while its user input is
the rendered thread (and the inbox-only truncation note when applicable); its account-scoped directory
and `extraction.` filename prefix keep it separate. Before promotion, extraction, and concept
synthesis, the command compares a cache-aware estimate with remaining `--budget`. Each paid response
is cached before actual spend is checked, so a stopped build can reuse it and the published brain is
unchanged.

The promotion prompt's sender line is separately versioned in `promotion.json`. Version 2 adds the user's
engagement counts; older cumulative decisions remain readable and warn until the file is moved aside, because
relabeling them would falsely claim they were made from the new paid input.

## File map

```text
src/cli.ts                        argv dispatch, umask, error rendering
src/commands/auth.ts              `roze auth`: OAuth and profile verification
src/commands/generate.ts          `roze generate`: flags, context, usage summaries, injectable seams
src/commands/prompt.ts            `roze prompt`: one question, answer, counters
src/generation/phases.ts          phase plan, recent window, and mid-build "not yet available" status
src/generation/buildBrain.ts      phased build, engagement ordering, staged render, metadata
src/gmail/client.ts               paced, retrying, quota-metered Gmail reads; ingest entry point
src/gmail/auth.ts                 loopback OAuth sign-in, token file, refresh direct or via the token proxy
src/gmail/messages.ts             Gmail wire format to EmailMessage: MIME, addresses, sender-local dates
src/gmail/http.ts                 injectable fetch and one shape for a failed Google answer
src/ingest/mail.ts                full-read ids, resumable fetch, configurable recent skim; ingest entry point
src/ingest/cache.ts               cached thread files, header JSONL, on-demand thread ids
src/ingest/engagement.ts          per-sender behavior score and deterministic body order
src/ingest/promote.ts             engagement-aware all/recent/latest/ignore, versioned decisions
src/memory/extractThread.ts       per-thread prompt, schema, cache request, mapping
src/memory/resolveEntities.ts     conservative identity resolution and item filing
src/memory/openLoops.ts           loop materiality, named-date expiry, current open-loop list
src/memory/transactions.ts        typed receipt rows parsed from automated mail
src/memory/recurringMerchants.ts  repeat-receipt groups, cited, for interest review
src/concepts/buildConcepts.ts     cards → stages → both gates → related mail; cost estimate
src/concepts/tagLifeDomains.ts    closed life-domain taxonomy, tag prompt, cached tag batches
src/concepts/buildClusters.ts     entity/domain/topic groups, capped and split by year when oversized
src/concepts/topicClusters.ts     topic normalization, subject vocabulary, Jaccard union-find groups
src/concepts/judgeClusters.ts     judge prompt, enum citations/locality, legacy and topic hash buckets
src/concepts/applyGates.ts        the gate boundary: parse, gate, collapse, sort, count
src/concepts/evidenceContext.ts   the evidence index and the grounding checks both gate sets share
src/concepts/projectGates.ts      every deterministic project acceptance rule
src/concepts/interestGates.ts     every deterministic interest acceptance rule
src/concepts/dedupeConcepts.ts    near-duplicate and subsumed-name collapse across clusters
src/concepts/conceptTrace.ts      proposal lineage through gates, dedupe, review, and final files
src/concepts/reviewRequests.ts    review prompts, input tables, payload budget, response schemas
src/concepts/reviewConcepts.ts    whole-list merge, tracks, demotion, narratives
src/brain/renderEvidence.ts       raw threads, window-labelled thread/inbox lists, transaction files
src/brain/renderThreadSummaries.ts one summary line per thread, by year, plus open threads
src/brain/renderEntities.ts       person/organization profiles and the open-loop index
src/brain/renderConcepts.ts       project/interest files, proposal trace, indexes, concepts.json
src/brain/renderRootIndex.ts      INDEX.md: coverage boundary, layout, navigation, citation contract
src/brain/storage.ts              paths/scopes, staged swap, Windows retry, rollback
src/query/answerAgent.ts          bounded loop: budget extension, verification and header rounds
src/query/answerPrompt.ts         the frozen system prompt and the index bundle
src/query/toolContracts.ts        the three tool argument schemas, descriptions, output bounds
src/query/searchIndex.ts          derived FTS5 rows, fingerprint/rebuild, BM25 and stable ranking bonuses
src/query/memorySearch.ts         FTS/literal dispatch, literal reference scan, grouped/summed tally
src/query/memoryTools.ts          read_memory, read_email, and tool dispatch
src/query/memoryPaths.ts          retrieval allowlist, symlink rejection, scope globs
src/query/citations.ts            grounding audit of every [t:<id> <day>]
src/llm/models.ts                 models, prices, usage/budgets, cache/call boundary
src/llm/provider.ts               OpenAI Responses transport: one POST, bounded retry, result read
src/context.ts                    generation dependencies and progress reporter
src/tui.ts                        ui facade and the status board: the one terminal writer in rich mode
src/types.ts                      shared domain vocabulary
src/shared/atomicFiles.ts         atomic JSON/text writes and environment loading
src/shared/dates.ts               owner-offset timeline and calendar helpers
src/shared/text.ts                normalization, names, slugs, hashing
bench/retrievalRecall.ts          zero-cost hit@5/10/20, MRR, and latency comparison for literal vs FTS
bench/*.ts                        explicit benchmarks and two offline validators
test/*.test.ts                    97 offline behavior tests with fake HTTP/models and synthetic search indexes
```

For the exact published tree, command examples, and verification commands, see [README.md](README.md).
