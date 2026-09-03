---
title: Costs and caching
tags: [operations]
---
# Costs and caching

Every paid call goes through one cached, metered layer: cache key = sha256(model + system + user); the
schema is not part of the key so plumbing changes never repay; rejected outputs are quarantined; a shared
paid-call ceiling and a usage ledger stop a run that crosses `--budget`. Before each paid stage the CLI
prints `expected ≈ $x`.

Reference mailbox (2,792 extracted + 19,994 body-only threads): cold model build ≈ $1.4 (extraction ≈ 0.35,
promotion ≈ 0.04, tags ≈ 0.03, judge ≈ 0.6–0.8, review ≈ 0.15); unchanged rebuild $0; a prompt ≈ 6¢.

What repays what: rendered thread text or the extraction prompt → extraction and everything after; the tag
prompt → tags and judge; the judge prompt → judge and review; the review prompt → review only. The judge
key uses the month, not the day ([[Judge cache keyed by month and hash bucket]]). Reasoning effort is not
part of the key: delete the cache file to re-run at a different effort.
