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
behind the judge. Related: [[Pipeline phases]], [[Costs and caching]], [[Bodies before concepts]].
