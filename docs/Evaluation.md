---
title: Evaluation
tags: [evaluation]
---
# Evaluation

Answers are graded by a blind judge against references; every citation is audited mechanically.

| Set | Data | Result (gpt-5.4 answers) |
|---|---|---|
| Dev, 30 items | reference mailbox, iterated against | 23 correct / 4 partial / 3 wrong (not decision-grade) |
| Sealed holdout v4, 32 | reference mailbox, never iterated against | 23 / 5 / 4 |
| Sealed holdout v3, 33 | reference mailbox, hardest references | 16 / 9 / 8 |
| v3 project + interest items, 11 | the concept layer | 0/5/6 → 0/9/2 → 2/6/3 after the review pass |
| EnronQA, 60 | public corpus, another person's inbox, third-party questions | 55 / 3 / 2 on the final code (46 / 2 / 12 before storing every body), grounded 60/60 |

Grounding held on every judged answer. Weakness: dense multi-year narrative questions (partial answers,
look-alike citations). Generalization evidence beyond the reference mailbox is the Enron number, rerun on the final
code; its concept layer (11 projects, 25 interests: a ski trip, a job search, a golf tournament, monthly
mutual-fund purchases with tracks; baseball, golf, college football) reads as that person's life, not as
anything shaped for the reference mailbox. Only grounded cases count; single runs move by two or three
items. See [[No test-specific or inbox-specific rules]].

Model experiments: gpt-5.4 answers beat gpt-5.4-mini (23 vs 14 correct on v4); moving the concept judge to
gpt-5.4 did not help; Gemma 4 (26B regresses, 31B free-tier only) was rejected. See [[Models and effort]].
