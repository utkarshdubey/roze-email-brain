---
title: Thread is the unit
tags: [decision]
---
# Thread is the unit

Ingestion, extraction, caching, and citation all work on complete Gmail threads. Recent-message sampling
loses endings (an older rejection or payment closed the thread); summaries-then-merge (the first pass)
was confidently wrong. One structured extraction per thread keeps the paid request, cache invalidation,
and provenance local. Related: [[Every claim cites a thread and a day]], [[Four tiers of mail]].
