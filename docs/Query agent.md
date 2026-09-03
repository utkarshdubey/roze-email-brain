---
title: Query agent
tags: [architecture, query]
---
# Query agent

`prompt <query>` runs one bounded agent loop (gpt-5.4) with three typed tools:
- `search_memory` — literal-safe, BM25-ranked, Porter-stemmed search from an account-scoped derived index
  over an explicit scope (people, organizations, projects, interests, open_loops, thread summaries,
  transactions, evidence), or a **tally** (`group_by` subject / sender / merchant / kind / currency / day /
  month / year, `amounts=sum`, `from`/`to`) so counting and totals are computed, never sampled. Tallies and
  the compatibility fallback retain the complete literal scanner.
- `read_memory` — a file inside the brain's allowlist (symlinks and traversal rejected), with line ranges.
- `read_email` — a header-only row fetched live from Gmail, cached for the next generate.

Rules the harness enforces, not the model: every citation must name a thread the agent opened (or a view or
tally row it read) with a day that heads a message; one repair round, then a visible warning. An absence
claim first forces reads of the header-only rows its own searches surfaced. The tool budget starts at 12 and
extends by 8 while calls keep opening new material, up to 48 calls / $1. Tools stay declared at the cap so
the cached prompt prefix is stable. See [[Typed tools, never a shell]] and [[Counting is tool work]].

The index is `.cache/<account>/search.sqlite`, never a published view. The first search builds it from the
allowlisted Markdown when missing or stale; publication deletes it. `ROZE_SEARCH=literal` selects the
reference scanner, and a runtime without `node:sqlite` falls back once with a verbose diagnostic.
