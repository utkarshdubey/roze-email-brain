# Design notes

The design favors inspectable provenance over infrastructure. Models compress and organize mail;
code decides what may be stored, cited, read, and paid for.

## How to read this in twenty minutes

1. Read the command, phase, layout, and acceptance tables in `README.md`.
2. Read `src/cli.ts`, then `src/commands/generate.ts` and `src/generation/buildBrain.ts`, for the commands and
   the complete cost-checked, staged build.
3. Read `src/ingest/mail.ts` for caches, coverage, and sender promotion, then extraction and entity
   resolution for local memory, transaction parsing, and recurring merchants.
4. Follow `src/concepts/buildConcepts.ts` through tagging/clustering, judgment, gates, whole-list
   review, the second gate pass, and related-mail attachment.
5. Read `src/query/answerAgent.ts` for the other data flow: question → three tools → audit → answer
   or visible warning.
6. Read `src/llm/models.ts` for provider/cache/cost policy, then the `src/brain/render*.ts` modules
   and `src/brain/storage.ts` for published views and atomic publication. The validators prove a real brain.

The tiers earn their place because most mail is automated: modeling it all costs more and adds
noise, while reading only conversations misses offers, notices, and receipts. The gates earn theirs
because a semantic judge invents lifecycle state; deterministic vetoes are cheaper and auditable.

## Complete threads, selective extraction

Recent-message sampling loses endings: a thread can look open when an older rejection,
cancellation, payment, or decision actually closed it. Roze therefore reads every thread the user
sent in or starred, for all time, and extracts each complete thread as one unit.

Most inbox mail is automated. Running every body through a model would cost more and make the memory
noisier, while keeping only conversations would miss receipts, account notices, and inbound
opportunities. The recent inbox window (24 months by default) therefore has separate costs:

- every header and Gmail snippet becomes a searchable index row;
- a sender-level model promotes a bounded subset for extraction;
- every remaining body is stored as raw evidence without extraction.

The skim has a fast pass because listing automated mail can delay the people the user cares about.
It excludes obvious automation and learns consistently automated domains from a bounded sample. A
complete pass follows so that banks, tools, recruiting systems, and other useful automated senders
can still be promoted. Excluding them permanently would trade latency for missing memory.

## Local facts before global concepts

One strict extraction records a thread summary, end state, mentions, and a few dated facts or loops.
This keeps the paid request, cache invalidation, and provenance local to one thread. Promoted
inbox-only threads expose less body text and allow four items rather than eight because the user did
not participate.

Identity resolution stays deterministic. Exact unique email wins, then an established alias, then a
first name inside a compatible organization. Ambiguity creates separate entities and a merge
candidate instead of silently combining people. Names tied to the owner's exact address identify
self and never create a contact.

Open loops also have a narrow lifecycle: they need material stakes, cannot survive a resolved source
thread, and leave the current index after 365 days of silence or once all named dates pass. Their
historical facts remain in the entity file. Cross-thread loop resolution is deliberately absent because a
plausible continuation is not proof that a commitment closed.

## Why concepts are cluster-first

Projects and interests span threads, but a mailbox-wide prompt is too large and encourages unrelated
efforts to merge. Roze first makes body-free cards, adds a small life-domain taxonomy, and builds
bounded entity, domain, and topic clusters. Topics normalize only generic function words and combine
the model's short label with subject vocabulary; Jaccard union recovers recurring efforts that share
neither one counterparty nor one broad domain. Oversized clusters split by year, preserving older efforts
without increasing the judge request cap. The judge can cite only exact thread/day pairs supplied in its
own cluster. Topics hash into a separate eight-bucket namespace, leaving the original 24 entity/domain
cache inputs stable.

Model output then passes deterministic gates in `src/concepts/applyGates.ts`. The important reasons
for those checks are:

- a real message day is the minimum useful provenance;
- state and outcomes may come from people or transactional systems, but never bulk mail;
- a project needs recurrence, a cited goal, and normally enough duration to be an effort rather than
  an incident;
- project participants, aliases, and organizations must appear in cited material;
- an interest needs repeated positive behavior, while direct participation remains distinct from
  passive receipts and notices;
- later positive or negative evidence may correct state, but one child organization cannot end a
  broader interest;
- narrative years, tracks, and related rows must resolve to the evidence they describe.

Clustering has the opposite weakness: the same effort can appear in several clusters. One bounded
review call per accepted list therefore merges duplicates, forms umbrella projects with tracks,
demotes non-projects, groups interests, and writes narratives. It may also use current loops and
recurring merchants parsed from raw receipts. Its references are limited to member evidence and
explicit context, unmentioned concepts survive unchanged, every verdict is logged, and the same
gates run again.

Named counters make aggregate failures measurable but used to hide the fate of an individual proposal.
The proposal trace now records source cluster and citations, both gate/dedupe passes, the review verdict,
and the final file or drop stage. It is published as Markdown for inspection and as structured JSON for
tools. This metadata stays outside every model input and does not alter accepted lists or counter values.

## Plain files and derived ranked retrieval

Markdown makes every layer readable without a service, migration, or special client. Raw thread
files are authoritative; entity and concept pages are navigation. Ranked lookup is derived rather
than published: an account-scoped FTS5 cache indexes each searchable line with Porter stemming and
combines BM25 with the existing phrase, inbox-person, and recency preferences. The same scope globs
remain the sandbox, every MATCH fragment is quoted data, and the existing per-file share is applied
after ranking. A fingerprint rebuilds stale indexes, while generation removes the cache after each
publication. The literal scanner stays as the compatibility fallback and the reference selected by
`ROZE_SEARCH=literal`.

This separation also keeps counting exact. Grouped search still scans complete yearly indexes and
never samples ranked hits; typed transaction rows make amount and merchant aggregation mechanical.
On the 30-item development retrieval bench, broad all-scope hit@20 moved from 11/30 literal to 22/30
FTS, MRR from 0.2043 to 0.4572, and latency from 7,435.03 ms to 624.94 ms. The four-mode overall mean
fell from 3,073.20 ms to 214.25 ms (14.34×), after a 12.41 s cold build; sealed evaluation is still
outstanding.

The answer agent receives no shell and no write tool. Its allowlist exposes three operations:
search generated views, read line ranges from them, and fetch one indexed header-only Gmail thread.
A fetched thread is cached for the next build. Paths cannot be absolute, traverse upward, enter
caches, follow symlinks, or name arbitrary file types.

Derived pages are useful leads but not independent proof. The grounding audit accepts a citation
only after the agent read the cited view row or opened the raw thread and the cited day matched a
message heading. It also challenges absence claims when the agent's own search found unread headers.
The tool budget grows only while new material is being opened, so broad questions can finish while a
repeating loop stops.

## Why every body is stored but only selected mail is extracted

Gmail reads and model reads are different costs. The final body-evidence phase therefore stores raw
text for every remaining inbox thread in the configured recent window, while extraction remains limited to
participated, starred, on-demand, and promoted threads. On the public Enron inbox, seven of twelve
retrieval misses existed only as subjects and snippets. Storing all bodies took the fourteen
previously missed questions from 4 to 9 correct, including all seven header-only misses, at zero
model cost and about fourteen minutes of paced Gmail time on the reference mailbox. `read_email`
still covers intermediate builds and bodies Gmail could not store; fetched threads join the next
generation's extraction set.

## Why counting and the tool budget are deterministic

A few retrieved examples cannot answer “how many,” “most,” or “how much.” `search_memory` therefore
has a grouped mode that scans every matching yearly-index row once and can sum the already parsed
transaction amount column. On the reference mailbox this turned 1,077 DoorDash confirmations into
a ranked result in one call; the answer changed from wrong to right at about eight cents. Tally and
derived-view citations count as opened evidence because the offline validator proves their thread
and day, preventing the grounding repair from replacing a complete tally with a handful of examples.

A fixed tool cap also truncated list questions because every answer item could require a raw read.
The cap now grows by eight only when the preceding window opened new threads or views, never beyond
48 calls or one dollar. Repetition ends the search. This is mailbox-general progress accounting,
not a question-specific exception.

## Why the skim and publication are phased

On the reference mailbox, the two-year skim listed 21,908 messages but only 909 passed the human-
sender filter; 20,999 metadata reads were discarded. Excluding sender tokens already rejected by
the same local classifier cut the listing to 10,747 ids and lost 17 human-looking rows, all fraud
alerts, newsletters, or receipts. Generic tokens that collide with people (`team`, `support`,
`info`, `hello`, `news`) remain deliberately absent. A newest-first sample of 1,500 headers also
learns consistently automated domains. The complete backfill still lists everything: permanently
excluding automation would have hidden 165 senders the promotion model chose on that mailbox.

The backfill reads threads, not headers. A skim thread used to be paid for twice: one metadata read
(5 units) to index it, then one thread read (10) for its body. Reading the thread once in phase 3 and
deriving the index row from its first message costs 10 instead of 15 and leaves the body phase with a
cache hit. The fast pass stays header-only: its job is to surface people within minutes.

Single-message threads are read as one message. Listing the window's messages instead of its threads
costs the same five units per page and also says how many messages each thread has; on the reference
mailbox 21,058 of 21,616 inbox threads are one message, and `messages.get` (5 units) returns exactly
what `threads.get` (10) would for them. The body phase, which is most of a cold build's Gmail time,
roughly halves. A message the listing could not see (older than the window, or in an excluded
category) is not fetched by a single-message read; `read_email` still fetches such a thread whole.

Access tokens live an hour and a build can run longer. The Gmail client asks a token source before
every request; the source renews the token a few minutes before its saved expiry, shares one renewal
among the workers that reach the boundary together, renews once more if Gmail still answers 401, and
saves the result for the next command. A failed renewal surfaces as "run `roze auth`", not as a
request that failed six times.

A reviewer needs only an OpenAI key. The project's public OAuth client id is a default in `auth.ts`, and
without a `GOOGLE_CLIENT_SECRET` in `.env` the authorization-code exchange and every refresh go through a
small Cloudflare Worker (`ROZE_TOKEN_PROXY`, also a default) that holds the secret, adds the client id and
secret, and returns Google's answer unchanged. A desktop client's secret is not truly secret, but handing it
out in a `.env` is still worse than a proxy that only ever exchanges codes for this one client id. The token
file records the proxy so refreshes keep working; with a secret present nothing changes and Google is called
directly.

Gmail work and model work overlap wherever nothing depends on both: the first header skim overlaps
full-read extraction, and body fetching overlaps concept judging, since only the review that follows
needs the recurring merchants parsed from every stored body. `buildConcepts` is split at that seam into
`judgeConceptCandidates` and `reviewAndFinishConcepts`, kept as their sequential composition for the bench.
Each phase publishes a whole staged tree as soon as it is useful; a second terminal can query it and
never sees half a generation. `--publish-once` changes only when swapping occurs, which is preferable
during a rebuild when the old complete brain is more useful than a new partial one.

## Why user behaviour orders recent ingestion

Categories describe mail, not whether the user valued it. Cached headers already carry stronger personal
signals: opened, important, starred, retained in the inbox, and whether the thread belongs to the all-time
participated set. Roze combines their per-sender shares as `(4 × replied + 2 × starred + 2 × important +
opened + kept in inbox) / 10`, then downloads body-only threads by score, recency, and id. The promotion
sender line receives the same counts. Because that one allowed prompt sentence changes paid inputs,
`promotion.json` now records sender-line format 2 and older cumulative decisions warn without being discarded.

`--recent <months>` changes only the skim listings; participated, starred, and on-demand mail stays all-time.
The default retains the existing 24-month query and Markdown bytes, while custom coverage is explicit in
metadata and headings. Every outbound Gmail attempt is also counted by resource kind and quota units in the
final summary. These are instrumentation and prioritization mechanisms; their real-mailbox value remains to
be measured by the coordinated cold-Gmail comparison and promotion audit.

## What the measurements changed

`bench/auditPromotion.ts` compares sender decisions with a stronger model on a stratified sample.
The first nano prompt agreed on 71 of 120 senders. Merely switching that prompt to the mini model
made agreement worse (63 of 120) and expanded `latest` promotion from 42 to 307 senders. The useful
change was instead to make ignoring cheap because headers and `read_email` remain available, and to
state the generic ignore cases. Audit opinions are cached per sender row.

`bench/evalAgent.ts` records tool calls, opened threads, first-draft grounding failures, surviving
citations, decoys, cost, and optional blind grades. On the 30-item development set, removing
middle-truncated reads after 6,000 characters, making outcome search recent-aware, restricting live
reads to header-only rows, and raising the cap moved 16 correct to 18; the tightened-promotion brain
reached 23 correct, 4 partial, and 3 wrong, citing the expected thread on 27. The grounding audit
rejected every unopened citation and repaired five or six drafts per run.

The sealed baselines were 14/11/7 (correct/partial/wrong) on 32 v4 questions and 11/10/12 on 33 v3
questions, with the expected thread cited on 28 of each, zero unverified citations, and respectively
3 and 5 decoy citations. Every expected thread was present for 62 of the 65 combined items. Using
`gpt-5.4` rather than `gpt-5.4-mini` for answers raised correct counts from 14 to 23 on v4 and 11 to
16 on v3. Using the larger model for concept judgment did not help: v3 was 15/7/11 and projects
remained 0 of 6, so the judge stayed cheaper and the architecture changed instead.

Whole-list review, receipt context, yearly splitting of oversized domains, and gate adjustments
then moved the same eleven project/interest items from 0/5/6 to 0/9/2 and finally 2/6/3, always
grounded. The agent read roughly twice as many threads and decoy citations rose from 1 of 10 to 4 of
10, exposing the tradeoff: synthesis recall improved, but similar efforts remain hard to separate.
Single runs move by two or three items, and the references predate the final brain, so these are
diagnostics rather than claims of general accuracy.

The reference full build extracted 2,792 threads, stored another 19,994 as raw bodies, and cost
about $1.4 in model calls. An unchanged rebuild made zero model calls and cost $0. A typical answer
cost about $0.06; the complete DoorDash tally described above cost about $0.08.

## Operational safeguards

- Dates use the owner's UTC offset at the time, inferred as a timeline from sent mail. This prevents
  an 8:23 PM New York event in UTC-stamped automated mail from moving to the next day; on the
  reference mailbox the timeline records the move from India time to Eastern time in 2022.
- Structured responses are cached by model plus the exact system and user prompt. The schema is not
  in the key, so harmless schema plumbing does not invalidate paid work. Extraction uses the same
  formula; its rendered thread and last message day make changed mail invalidate only that thread.
- Cache-aware estimates stop a stage before it starts; the actual ledger checks again after each
  response is safely cached. A budget failure leaves reusable work and the published brain intact.
- Publication renders a complete staging tree and swaps all targets together. Partial rename failure
  restores the old generation; bounded Windows retries handle transient file locks.
- Account-scoped caches prevent two sign-ins sharing one brain root from mixing mailbox data.

## Deliberately absent

- Embeddings or a vector database: a derived local FTS index adds stemming and ranking while keeping
  lower operational and audit cost.
- Model-driven identity merging: the hallucination risk outweighs the convenience.
- A provider SDK or application framework: global `fetch`, Zod, and small modules cover the boundary.
- A daemon, web UI, multi-user service, or answer write-back: the product is a one-user CLI and its
  query path is read-only apart from caching an explicitly fetched message.
- Incremental Gmail history application: the history id is stored, but resumable caches keep full
  regeneration simple.
- Hidden paid evaluation: normal tests and validators are offline; scripts that may call models or
  external datasets are explicit under `bench/`.

The remaining quality ceiling is concept synthesis, not storage coverage: related efforts can still
be split or over-merged, and lexical search depends on words or stems present in the stored mail. Any larger
design should first demonstrate a grounded improvement in the instrumented benchmark traces.
