---
title: Skim coverage is explicit
tags: [decision]
---
# Skim coverage is explicit

`generate --recent <months>` accepts a positive integer and changes only the skim tiers; participated,
starred, and previously fetched-on-demand threads remain all-time. The default is 24 months and retains the
existing `newer_than:2y` query and two-year Markdown wording. A custom boundary is recorded in `meta.json`,
`INDEX.md`, and the evidence headings, and cached header rows are filtered through the current listing so a
shorter window cannot republish older rows. Related: [[Pipeline phases]], [[Brain layout]].
