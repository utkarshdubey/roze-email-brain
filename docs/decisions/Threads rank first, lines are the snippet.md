---
title: Threads rank first, lines are the snippet
tags: [decision, query]
---
# Threads rank first, lines are the snippet

The index stored one FTS row per Markdown line, so BM25 rewarded short lines (a signature, a `to:` header)
and could not add up a term's hits across a thread. Every thread the benchmarks asked about was already
indexed; it lost on the ranking unit, not on coverage.

For `any_term` searches in `all` with a word term, `ceil(2L/3)` of the `L` result slots now go to threads
ranked by equally weighted Porter BM25 over subject, header, summary, and body, plus the existing inbox
person +15 / auto -5 term. Each thread shows its best line under the existing phrase, person, and recency
score. The remaining slots use the existing line and filename order, deduplicated by thread. Stage order is
preserved even when a remainder line has a larger score. All other searches and tallies keep their behavior.

Measured with `bench/threadStage.ts` on two public Enron mailboxes with EnronQA questions, no model involved.
The design, the metric (expected thread visible within the limit), and the ship line (+12 points, CI lower
bound above +5, at most 5 full-question losses) were fixed on the first mailbox before the single run on the
second: three-keyword queries at limit 10 went 59.5% → 72.6% (+13.2 points [9.2, 17.4], 59 won / 9 lost) and
full questions 76.3% → 90.3% (54 won / 1 lost). A keyword search costs 5.7 ms against 4.1 ms.

Schema v2 adds a `thread_id` column and a contentless thread FTS table to the disposable cache. Thread
documents use SQLite's returned text (including its first-NUL boundary). Best lines are selected together in
one query. Published bytes, answer prompts, tool contracts, and fingerprint inputs apart from the schema
version stay unchanged. `ROZE_SEARCH=lines`, `engine: "lines"`, or `threadStage: false` restores the previous
line ranking through the same index; `ROZE_SEARCH=literal` still selects the scanner.

Limits: both corpora are person-to-person mail with a body for every thread, and the keywords are simulated
(the three highest-IDF question terms). Body-less automated inboxes and real agent keyword choices are
unmeasured. The slot share is a design choice, not a tuned number: rows without a thread id can never be the
expected answer on Enron, so the benchmark cannot choose it.
