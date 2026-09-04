---
title: roze brain — home
tags: [moc]
---
# roze — the agent's brain

This vault is the working memory for anyone (human or agent) changing this codebase. Read it before
touching code. The submission-facing documents are the README, [[ARCHITECTURE]] (contracts and file map),
and [[NOTES]] (decisions and tradeoffs); this vault holds the *why* behind them in small, linked notes.

## Start here
1. [[Working conventions]] — the rules every change must respect (no cheating, frozen prompts, guards).
2. [[Architecture]] — the two data flows in one page.
3. [[Pipeline phases]] · [[Brain layout]] · [[Concept layer]] · [[Query agent]] · [[Costs and caching]]
4. [[Evaluation]] — what has been measured, on which data, and what it means.
5. [[Gotchas]] — things that cost real time once.

## Settled decisions (do not re-litigate without new evidence)
- [[Thread is the unit]]
- [[Every claim cites a thread and a day]]
- [[Identity never merges on a model's say-so]]
- [[Open loops have a lifecycle]]
- [[Four tiers of mail]]
- [[Engagement orders inbox reads]]
- [[Skim coverage is explicit]]
- [[Gmail usage is measured]]
- [[Cluster first, then gates, then one review]]
- [[Topics are the third cluster family]]
- [[Every proposal leaves a trace]]
- [[Bodies before concepts]]
- [[Graph database rejected]]
- [[Typed tools, never a shell]]
- [[Counting is tool work]]
- [[No test-specific or inbox-specific rules]]
- [[Lines are not the metric]]
- [[Models and effort]]
- [[Judge cache keyed by month and hash bucket]]
- [[Interests are two-tier]]
- [[Lightweight, no frameworks]]
- [[One status board owns the terminal]]
- [[Read each inbox thread once]]
- [[Ranked retrieval is a derived cache]]
- [[Deferred features]]
- [[Token exchange goes through a proxy]]

## Product brief (what it is judged against)
A CLI with exactly three commands — `auth`, `generate`, `prompt <query>` — that turns a Gmail history into a
lightweight, queryable brain understanding **people**, **projects** (outcome-oriented efforts with an
endpoint), **interests** (recurring interests, organizations, tools, hobbies, subjects), and **open loops**
(unresolved commitments, follow-ups, decisions, actions). Real OAuth app in Testing mode. No web UI, no
multi-user infrastructure, no exhaustive tests. Keep the scope small enough that the core memory design is
easy to understand.
