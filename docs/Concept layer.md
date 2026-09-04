---
title: Concept layer
tags: [architecture, concepts]
---
# Concept layer (projects and interests)

The one place a model sees more than one thread at a time, so it is bounded at every step.

1. **Cards**: body-free projections of each extracted thread (days, subjects, summary, state, mentions, items).
2. **Tags**: a nano model assigns up to three life domains from a closed taxonomy and a short topic.
3. **Clusters**: deterministic — entity clusters by organization/person (union-find on names, emails,
   compatible organizations, co-occurrence), domain clusters, and topic clusters from normalized tag labels
   plus subject vocabulary. Topic groups merge at token-set Jaccard ≥ 0.5. Oversized entity, domain, and
   topic clusters split **per year**, so an old effort is not displaced by a counterparty's newest 30 threads.
4. **Judge**: one mini-model call per batch of clusters. Entity/domain clusters retain their 24 hash buckets;
   topics use eight separate `topic:` buckets, so adding the third family leaves the old cache inputs intact.
   Buckets are keyed by month so rebuilds do not repay. The response schema binds evidence to an enum of
   `<thread>::<day>` pairs present in the request; evidence outside the producing cluster is rejected.
5. **Gates** (deterministic, each a named counter): real message days; state/outcome from a person or
   transactional mail, never bulk; projects need two threads, a cited goal, 14 days unless the user drove
   them across threads; loop-like names are not projects; grounded names and aliases; interests need
   positive behavior on two dates in two threads; later evidence corrects state; near-duplicates and
   subsumed names collapse.
6. **Review**: one call per list over everything the gates accepted — projects with the open loops,
   interests with recurring merchants from the receipts table. Verdicts are enumerated (merge, umbrella with
   tracks, demote/drop with a reason the code checks, keep with a narrative); anything unmentioned is kept;
   evidence is again an enum limited to what the members cite. Medium reasoning on the short list, low on
   the long one, with one retry at low effort when a response spends its cap reasoning.
7. **Gates again**, then **related threads** by literal whole-name search over every stored thread.
8. **Trace**: every judge proposal records its name and kind, source cluster and citations, named outcomes
   from both gate and dedupe passes, review disposition, and final file or drop stage. `concepts/TRACE.md`
   renders the final stages first; the same rows live under `trace` in `concepts.json`. Aggregate counters and
   accepted concept files retain their existing shapes.

Why: a flat synthesis over all cards scored 0/10 in two audits; per-cluster judging alone fragments one
effort into pieces and cannot see receipts from unread senders. See
[[Cluster first, then gates, then one review]], [[Topics are the third cluster family]],
[[Every proposal leaves a trace]], [[Interests are two-tier]], [[Bodies before concepts]].
