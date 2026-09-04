---
title: Blog draft
tags: [writeup]
---
# Files, not vectors: a Gmail memory that cites its sources

*I built a CLI that turns ten years of email into a brain you can question, for about a dollar. Most of the interesting decisions were about what not to build.*

The brief was small on purpose: three commands. `auth` signs into Gmail read-only. `generate` builds a memory of the people, projects, interests and open loops in your mail. `prompt` answers one question from it. No web UI, no service. Two constraints I set for myself shaped everything: the build should cost cents, and every claim the assistant makes must point at the email it came from.

## The first version was confidently wrong

Version one summarised the mailbox into four files. It read beautifully and was wrong about almost every ending. A thread about a job looked open because the rejection was in an older message the summariser never weighed; two people with the same first name became one. Summaries of summaries lose exactly the details a memory exists to keep.

So the unit became the thread. Every thread I ever replied to or starred is fetched in full, all time, and turned into one structured record by a small model: a summary, an end state, the people and organisations in it, and a handful of dated facts and commitments. Each fact carries the date of the message that supports it, and a date that does not match a real message is thrown away. That one rule removed most hallucinated timelines.

## Most mail is not conversation

About nine in ten threads in an inbox are automated. Running all of them through a model costs real money and fills the memory with shipping notices. Reading only conversations misses the offer letter, the visa receipt, the lease renewal. The compromise is tiers: conversations in full, then a two-year skim of everything else where a small model looks at each *sender*, not each message, and decides whether to read all, the latest few, one, or none. The remaining bodies are stored raw, searchable and citable, but never sent to a model. The whole build is about $1.40 in model calls for 2,800 extracted threads and 20,000 stored bodies.

## Identity is code, not a model's opinion

Merging people is where memory systems quietly go wrong. Here it is deterministic: an exact email address, then an established alias, then a first name inside the same organisation. Anything ambiguous becomes a separate profile with a "might be the same person" pointer. The cost is that one person can have a profile per address. The benefit is that the memory never invents a relationship.

## Projects need a different shape

People are local: one thread tells you a lot about one person. Projects and interests are global: "my 2026 job search" is spread across forty threads and a dozen senders. My first attempt gave a model all the thread cards and asked for projects. Two audits scored it zero for ten. It merged unrelated efforts, borrowed names from neighbouring threads, and promoted purchases to projects.

The fix was to stop letting a model see the whole mailbox. Code forms clusters first, by organisation or person and by a small closed list of life domains. A model judges one cluster at a time, and it can only cite from an enumerated list of thread-and-day pairs that are actually in front of it. Deterministic gates then veto what it gets wrong: a project needs a cited goal, two threads, real duration; an interest needs the user doing something on two dates. One final review merges the fragments. Every rejection increments a named counter, so I can see exactly why a concept did not make it.

## Why not a vector database or a knowledge graph

I built a graph version and measured it. The questions the system got wrong failed on text coverage, counting and synthesis, not on entity traversal. The graph added infrastructure and moved no number, so it went into the attic. The memory is a directory of markdown files, and the assistant has three typed tools: literal search with tallies, a bounded file read, and a live fetch for a single email. Counting is done by the tool over every matching row, never by a model sampling a few threads. "How much did I spend on food delivery in March" comes back computed.

## The harness enforces honesty

Every answer is audited before you see it. A citation must name a thread the agent actually opened, with a day that heads a message in it. Fail, and the agent gets one round to go read what it cited. Claim something is absent while unread header-only rows sit in its own search results, and it must read them first. On a public corpus of someone else's mail, 60 questions came back grounded 60 out of 60 and 55 correct.

## What I would do next

The remaining error is in synthesis, not storage: similar efforts still split or over-merge, and long-tail lookups depend on the words being present in the two-year window. The next steps are a live search tool over all of Gmail for the needle-in-a-haystack case, a proper ranked index instead of first-N literal hits, and a bounded, asynchronous write-back so the brain learns from what the assistant finds. Each one gets a benchmark before it gets merged. That discipline, instrument first and change second, was the most useful thing I built.
