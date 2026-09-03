---
title: Pipeline phases
tags: [architecture]
---
# Pipeline phases

`generate` publishes up to five times so the brain is queryable long before it is complete; each phase is a
complete staged swap (`--publish-once` swaps only at the end, for rebuilds over a complete brain).

1. **Full read** — every thread the user replied to or starred, all time, fetched and extracted. Days are
   rendered in the user's own timezone from an offset timeline built from their sent mail.
2. **Fast inbox** — a recent header skim (24 months by default, configurable with `--recent`) that excludes
   obvious automation and learns bulk domains from a sample; a small model sees the user's own opened,
   replied, important, and starred counts and decides per sender what to read in full (`all` / `recent` /
   `latest` / `ignore`) under deterministic caps (25, 5 within 180 days, 1).
3. **Complete inbox** — the full recent-window header index, so automated senders that matter (banks, tools,
   recruiting systems) can still be promoted.
4. **Raw bodies** — every remaining inbox thread stored as searchable, citable evidence, never extracted.
   Threads the complete backfill already read in full come from the cache; the concept judge runs
   concurrently with this download (see [[Read each inbox thread once]])
   (Gmail time only). See [[Bodies before concepts]].
5. **Concepts** — projects and interests. See [[Concept layer]].

Why this order: people first (they are what the user cares about), then coverage, then the expensive
global synthesis, which needs the receipts from phase 4. See [[Four tiers of mail]].

Within phase 4, sender engagement orders uncached bodies before recency and thread id, so useful mail reaches
the resumable cache first. The command's final Gmail line reports attempts, quota units, resource counts, and
elapsed Gmail time. See [[Engagement orders inbox reads]], [[Gmail usage is measured]].
