---
title: Judge cache keyed by month and hash bucket
tags: [decision]
---
# Judge cache keyed by month and hash bucket

The judge prompt used to carry the day, so every rebuild on a new day repaid ≈ $0.40; it now carries the
month. Batches were packed sequentially, so one changed cluster shifted every later batch; clusters now
hash into 24 fixed buckets and only the changed bucket re-judges. Topic clusters use a separate eight-bucket
`topic:` namespace: introducing them cannot perturb the existing entity/domain request bytes, while a
changed topic remains local to one topic bucket. Related: [[Costs and caching]],
[[Topics are the third cluster family]].
