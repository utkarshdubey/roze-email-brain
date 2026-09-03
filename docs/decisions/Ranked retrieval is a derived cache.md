---
title: Ranked retrieval is a derived cache
tags: [decision, query]
---
# Ranked retrieval is a derived cache

`search_memory` ranks allowlisted Markdown lines with FTS5 (`porter unicode61`) and BM25, then applies the
existing phrase, inbox-person, recency, filename, and per-file-share rules. Every query fragment is bound as
a quoted FTS string; scope still comes from the published view globs. The database lives at
`.cache/<account>/search.sqlite`, fingerprints `meta.json` plus file paths, sizes, and mtimes, and is removed
after publication. Markdown remains the source of truth and an older brain builds the index on first use.

The complete literal scanner remains the reference, the fallback when SQLite is unavailable, and the only
tally engine. `ROZE_SEARCH=literal` is the rollback. On the 30-item development retrieval bench, broad
all-scope hit@20 rose 11/30 → 22/30, MRR rose 0.2043 → 0.4572, and mean latency fell 7,435.03 ms →
624.94 ms; the four-mode overall mean fell 3,073.20 ms → 214.25 ms (14.34×). Building the cold 342 MB
index took 12.41 s. Sealed-set evaluation remains for the coordinator.
