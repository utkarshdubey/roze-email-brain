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

Gmail time: 250 quota units per second per user is Google's documented ceiling (header 5, thread 10,
list 5), but the quota answer Gmail sends names "units per minute per user", and one measured account was
refused at about 1,500 units a minute, a tenth of the documented figure. The client keeps a sliding
one-minute window of the units it spent, learns the real cap from a refusal (90% of what the window held, never
below a quarter of the documented minute), raises it 5% per quiet ten seconds, spaces requests to spend that cap evenly across the minute (no burst,
no stall), and waits only until old units age out, never a whole minute. The
learned cap is printed with the Gmail usage line. Every skim thread is read exactly once (a single-message thread, 97% of the inbox, as one
5-unit message read), and the body download overlaps the concept
judge, so the critical path is phases 1–3 plus the longer of the bodies and the judge, plus the review.
Every outbound attempt, including retries, is now reported by resource kind at the end of `generate`; body
reads are ordered by the user's sender engagement so an interrupted build fills the cache in useful order.

What repays what: rendered thread text or the extraction prompt → extraction and everything after; the tag
prompt → tags and judge; the judge prompt → judge and review; the review prompt → review only. The judge
key uses the month, not the day ([[Judge cache keyed by month and hash bucket]]). Reasoning effort is not
part of the key: delete the cache file to re-run at a different effort. Promotion sender-line format 2 adds
engagement counts, so its model cache repays; old cumulative `promotion.json` decisions warn until moved aside.
