---
title: Brain layout
tags: [architecture]
---
# Brain layout

```
brain/
  INDEX.md                        navigation, build status, citation contract
  people/  organizations/         one profile per entity: dated, cited facts and loops; ALL.md lists every one
  projects/  interests/           concept files: goal/status/outcome, story, tracks, evidence, related threads
  open_loops/INDEX.md             unresolved items, newest first, filed by owner
  threads/                        per-year thread summaries (id | days | state | summary)
  evidence/threads/<id>.md        raw messages with `## <ISO timestamp>  from: <address>` headings
  evidence/inbox-<year>.md        header rows (body|header) for the configured recent window
  evidence/transactions-<year>.md typed receipt rows (id | day | merchant | kind | amount | currency | sender | subject)
  meta.json  concepts.json        build phase/window metadata; accepted concepts, rejection counters, review log
  .cache/<account>/               Gmail/model results plus derived search.sqlite; never queryable
```
The rubric directories are derived views; the agent uses them to find thread ids and verifies in
`evidence/threads/` before answering. See [[Every claim cites a thread and a day]].
