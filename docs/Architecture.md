---
title: Architecture
tags: [architecture]
---
# Architecture in one page

Two data flows, both ending in files a person can read.

## Build (`roze generate`)
Gmail → threads (participated and starred, all time; promoted senders; raw bodies for the configurable recent
window) → one structured extraction per thread → deterministic entity resolution and open-loop lifecycle →
body-free cards → life-domain tags → entity and per-year domain clusters → enum-cited cluster judge →
deterministic gates → whole-list review → gates again → related threads → rendered views, published by a
staged swap. Details: [[Pipeline phases]], [[Concept layer]], [[Brain layout]].

## Answer (`roze prompt`)
Question → an agent with three typed, non-mutating tools (`search_memory` with tallies, `read_memory`,
`read_email`) over an explicit path allowlist → citation grounding audit and header round → answer with
mandatory `[t:<thread> <day>]` citations. Details: [[Query agent]].

## Boundaries that matter
- Models propose; code owns provenance, identity, lifecycle, deduplication, cost, and publication.
- Gmail labels and participation produce a deterministic sender-engagement score that orders body reads and
  is shown to sender promotion; every Gmail attempt is metered by resource kind.
- Every stored claim resolves to a raw message in `evidence/threads/<id>.md` with a dated heading.
- One provider adapter, one cache-and-budget layer ([[Costs and caching]]), zod as the only runtime library
  besides the terminal UI packages.
- The current file map lives in [[ARCHITECTURE]]; keep it exact.
