---
title: Read each inbox thread once
tags: [decision]
---
# Read each inbox thread once

The complete backfill used to buy a metadata header (5 units) for every skim thread and phase 4 then
bought the same thread in full (10 units). It now lists thread ids, skips what the fast pass indexed, reads
each uncovered thread once in full, derives its index row from the first message (same fields, same bytes
apart from the message count), and caches it, so the body phase is a cache hit for those threads. The fast
pass stays header-only because its job is to surface people within minutes. Gmail and model work overlap
wherever nothing depends on both: the judge stage of the concept layer runs while bodies download, and only
the review waits, because it needs the receipts. Measured: 22% fewer Gmail units and the body fetch hidden
behind the judge. Since 2026-09-03 the backfill lists messages rather than threads (same five units per
page), so it knows which threads are one message and reads those with `messages.get` (5 units) instead of
`threads.get` (10): 21,058 of 21,616 inbox threads on the reference mailbox, so the body phase roughly halves. A
message outside the listing (older than the window, an excluded category) is not fetched by that read;
`read_email` still fetches such a thread whole. Uncached body reads are ordered by sender engagement before
recency and id, without changing the one-read cache boundary. Related: [[Pipeline phases]], [[Costs and caching]],
[[Bodies before concepts]], [[Engagement orders inbox reads]].
