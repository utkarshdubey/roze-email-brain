---
title: Engagement orders inbox reads
tags: [decision]
---
# Engagement orders inbox reads

Cached opening headers are grouped by normalized sender address. A sender's score is `(4 × replied share +
2 × starred share + 2 × important share + opened share + kept-in-inbox share) / 10`; replies carry the
largest weight, and every component comes from Gmail labels or the already-known participated-thread set.
Body-only thread ids are fetched by score descending, then newest first, then id, so an interrupted cold
build keeps the mail the user acted on first without sender-specific rules.

Promotion sees the same opened, replied, important, and starred counts. That changed its paid input, so the
sender-line format is versioned as 2. Older cumulative decisions remain usable but warn on every generate
until `promotion.json` is moved aside and rebuilt. Related: [[Four tiers of mail]], [[Costs and caching]].
