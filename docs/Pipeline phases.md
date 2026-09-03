---
title: Pipeline phases
tags: [architecture]
---
# Pipeline phases

`generate` publishes up to five times so the brain is queryable long before it is complete; each phase is a
complete staged swap (`--publish-once` swaps only at the end, for rebuilds over a complete brain).

1. **Full read** — every thread the user replied to or starred, all time, fetched and extracted. Days are
   rendered in the user's own timezone from an offset timeline built from their sent mail.
2. **Fast inbox** — a two-year header skim that excludes obvious automation and learns bulk domains from a
   sample; a small model decides per sender what to read in full (`all` / `recent` / `latest` / `ignore`)
   under deterministic caps (25, 5 within 180 days, 1).
3. **Complete inbox** — the full header index, so automated senders that matter (banks, tools, recruiting
   systems) can still be promoted.
4. **Raw bodies** — every remaining inbox thread stored as searchable, citable evidence, never extracted
   (Gmail time only). See [[Bodies before concepts]].
5. **Concepts** — projects and interests. See [[Concept layer]].

Why this order: people first (they are what the user cares about), then coverage, then the expensive
global synthesis, which needs the receipts from phase 4. See [[Four tiers of mail]].
