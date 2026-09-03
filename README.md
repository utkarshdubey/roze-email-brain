# roze-email

A small TypeScript CLI that turns one Gmail account into local, inspectable memory. People,
organizations, projects, interests, open loops, summaries, transactions, and raw messages are plain
Markdown; claims cite the supporting thread and the owner's local day as `[t:<thread-id> <YYYY-MM-DD>]`.

```text
roze auth              sign in to Gmail with gmail.readonly
roze generate          build and atomically publish brain/
roze prompt <query>    answer one question from that brain
```

## Working on the code

`docs/` is an Obsidian vault (open the repository folder in Obsidian, or read the Markdown): the architecture
in one page, every settled decision with its reason, the evaluation numbers, gotchas, and the working
conventions. `AGENTS.md` is the short version for coding agents. `ARCHITECTURE.md` is the exact file map and
contract reference; `NOTES.md` explains the tradeoffs.

## Setup

Requires Node.js 20+, a Google OAuth desktop-app client, and an OpenAI API key. Runtime dependencies
are Zod, `@clack/prompts`, and `picocolors` for the terminal UI; HTTP uses Node's global `fetch`.

```bash
npm install
cp .env.example .env
```

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `OPENAI_API_KEY`. The Google project must have
the Gmail API enabled; add the account as a test user when the consent screen is in testing.
Optional `ROZE_MODEL_*` overrides are documented in `.env.example`.

## Use

```bash
npm run roze -- auth
npm run roze -- generate --budget 2.00
npm run roze -- prompt "What projects am I working on, and where does each stand?"
```

`generate` shows progress and publishes up to five complete snapshots:

1. participated or starred threads, extracted into people, organizations, loops, and summaries;
2. a people-first recent inbox skim (24 months by default), with useful senders promoted to full reads;
3. the complete recent-window inbox index and any additional promoted senders;
4. raw bodies for the remaining indexed threads, stored as searchable evidence but not extracted;
5. projects and interests synthesized across entity, domain, and topic clusters; gated, reviewed as whole
   lists, gated again, linked to related threads, and accompanied by a proposal-fate trace.

Opened, replied, important, starred, and inbox-retention signals form a deterministic per-sender score.
Promotion sees the raw counts, and body-only downloads use the score before recency so an interrupted build
caches the mail the user engaged with first. If generate warns that `promotion.json` used an older sender-line
format, move the named file aside before rejudging those cumulative decisions.

`INDEX.md` and `meta.json` identify the current phase. Every publication is staged and swapped as
one tree; a failed partial swap restores the prior tree. `--publish-once` delays publication until
the final phase. On Windows, transient rename failures are retried because scanners and sync tools
can briefly hold newly written files.

Generate options are `--publish-once`, `--no-promote`, `--no-synthesize`, `--no-skim`, `--recent MONTHS`
(skim tiers only; default 24), and `--budget USD`. `prompt` accepts `--cap N` and `--quiet`. Before a paid
stage, the CLI prints its cache-aware expected cost; the budget is enforced both before the stage and after
each cached response. The final summary reports model usage plus Gmail requests, quota units, resource
counts, and elapsed Gmail time. Gmail and model results live under `brain/.cache/<account>/`, so unchanged
rebuilds make no model calls.

`prompt` can only call three tools: literal `search_memory`, allowlisted `read_memory`, and
read-only `read_email` for an indexed thread whose body is not stored yet. A grounding audit checks
every answer citation against material opened during that question and a real raw-message day. It
allows one repair round, then visibly flags anything still unverified. Frequency questions use
deterministic grouped counts over the yearly indexes rather than a sample of search hits.

### Terminal output

Output is rich (spinners, styled progress bars, colored intro/outro banners) only when stderr is an
interactive terminal; every message carries the same information either way. It falls back to the
plain lines shown above — no color, no cursor movement, one line per update — whenever stderr is
not a TTY (piped or redirected), `--quiet` is passed to `prompt`, or the `NO_COLOR` or `ROZE_PLAIN`
environment variable is set. `prompt`'s stdout carries only the answer in every mode, so
`roze prompt "..." | pbcopy` never picks up progress or trace output. When stdout is a terminal the
answer's Markdown is rendered for it — headings, bold, lists, inline code, and dimmed citations,
wrapped to the terminal width — and rich mode closes with a compact `12 tool calls · 31s · $0.06`
counter on stderr; piped or redirected output keeps the raw Markdown and the full counters line.

- Stages that run at the same time — the participated-thread fetch alongside the fast inbox skim, and
  later phases extracting while other stages report — share one **status board**: a single renderer
  owning a block of lines with one row per live stage, repainted in place. It is the only thing that
  writes to the terminal in rich mode, so an `info`, `step`, `warn`, or cost line is always inserted
  above the block and never inside a row, and a finished stage leaves one dim `threads 344/344 in 41s`
  line behind. Never add a second cursor-owning widget (a `@clack/prompts` bar or spinner, an ad-hoc
  `\r` line) while a stage can be live: two of them fight for the same terminal line, which is what
  stacked `17/344.` and `67/1500.` on one bar and lost the second label.

## Brain layout

```text
brain/
  INDEX.md
  people/INDEX.md, people/ALL.md, people/<slug>.md
  organizations/INDEX.md, organizations/ALL.md, organizations/<slug>.md
  projects/INDEX.md, projects/<slug>.md
  interests/INDEX.md, interests/<slug>.md
  concepts/TRACE.md                    proposal lineage through gates, review, and final files
  open_loops/INDEX.md
  threads/INDEX.md, threads/threads-<year>.md
  evidence/INDEX.md
  evidence/threads-<year>.md          full-read thread rows
  evidence/inbox-<year>.md            recent-window inbox rows, marked body or header
  evidence/transactions-<year>.md     parsed merchant, kind, amount, and currency rows
  evidence/threads/<id>.md             authoritative raw messages
  meta.json, concepts.json
  .cache/<account>/                    never queryable
```

Raw messages are oldest first. Their dates use the account owner's historical UTC-offset timeline,
learned from sent mail, so indexes and citations agree with the user's local day. The offline
validator resolves every citation to an exact message heading.

The memory rules are intentionally mechanical:

| Memory | Acceptance rule |
|---|---|
| People and organizations | Exact unique email, then an established alias, then a first name inside a compatible organization. Ambiguity remains separate, and the owner never becomes a contact. |
| Open loops | A material unresolved commitment or request. A resolved source thread closes it; 365 days of silence or every named date passing removes it from the current index, not history. |
| Projects | At least two threads, a cited goal, and normally 14 days of activity unless the user wrote in two cited threads. State, outcome, parties, aliases, tracks, and narrative must be grounded; review merges and demotions pass the same gates again. |
| Interests | Positive behavior on at least two dates in two threads. Direct participation stays distinct from passive receipts or notices; recurring merchants may contribute cited receipt evidence. |
| Narratives and related mail | Narrative years must fall inside the cited evidence span. Tracks and related rows must resolve to real message days; related mail comes from whole-name search over all stored threads. |

## Models and measured cost

| Stage | Default model | $/1M input / cached / output |
|---|---|---:|
| Answer | `gpt-5.4` | 2.50 / 0.25 / 15.00 |
| Extract | `gpt-5-nano` | 0.05 / 0.005 / 0.40 |
| Promote | `gpt-5.4-mini` | 0.75 / 0.075 / 4.50 |
| Tag | `gpt-5-nano` | 0.05 / 0.005 / 0.40 |
| Judge and review | `gpt-5.4-mini` | 0.75 / 0.075 / 4.50 |

The reference full build extracted **2,792 threads**, stored **19,994** more as raw bodies, and
cost about **$1.4** in model calls; an unchanged rebuild made zero calls and cost **$0**. A prompt
costs about six cents with `gpt-5.4`. On the sealed 32-question holdout it answered 23 correctly,
versus 14 for `gpt-5.4-mini` with the same brain and prompt, so answering is the one stage where the
larger model paid for itself. Mailbox mix, cache state, and overrides change these figures; use the
`expected ≈` line printed for the current run.

## Read the implementation

The two flows are:

```text
Gmail → selection → extraction → entities/loops → cards → domain/topic tags → three cluster families
      → judge → gates → whole-list review → gates → related threads + proposal trace → staged files

question → search_memory/read_memory/read_email → citation audit → answer
```

Start with `src/cli.ts`, then follow ingestion, extraction, entity resolution, and concepts through
the modules named in the first flow. Rendering is in the `src/brain/render*.ts` modules, paths/publication in
`src/brain/storage.ts`, Gmail in `src/gmail/client.ts`, model/cache/cost policy in `src/llm/models.ts`,
deterministic concept policy in `src/concepts/applyGates.ts`, and the query flow in `src/query/answerAgent.ts`. See
[ARCHITECTURE.md](ARCHITECTURE.md) for contracts and [NOTES.md](NOTES.md) for design choices.

## Verify

```bash
npm run typecheck
npm test
npm run validate
```

The 87 tests use injected models and fake HTTP. `validateCitations.ts` checks every generated
citation; `validateConcepts.ts` replays the production gates from caches and compares a temporary
render byte-for-byte. Both are offline. `bench/rebuildConcepts.ts` can preview a cache-backed concept
rebuild. `bench/evalAgent.ts`, `bench/auditPromotion.ts --second-opinion`, and `bench/enronBrain.ts`
may call external services and are intentionally explicit rather than part of the test suite:

```bash
# Which senders the promotion model chose to read, what the guards changed, and (paid, N calls)
# whether a stronger model agrees on a stratified sample.
npx tsx bench/auditPromotion.ts --second-opinion 120 --out bench/results/promotion-audit.json

# Run a question set: per question, the tool calls made, raw threads opened, grounding problems
# in the first draft, what survived, decoy threads cited, cost; --judge grades against references.
npx tsx bench/evalAgent.ts bench/eval.example.json --judge --out bench/results/eval.json

# Public, reproducible number: build a brain from one CMU Enron inbox and grade it on EnronQA.
npx tsx bench/enronBrain.ts --maildir maildir/giron-d --questions giron-d.dev.jsonl \
  --root brain-enron --out bench/results/enron.giron-d.questions.json --budget 3
npx tsx bench/evalAgent.ts bench/results/enron.giron-d.questions.json --brain brain-enron --judge \
  --out bench/results/enron.giron-d.eval.json
```
