---
title: One status board owns the terminal
tags: [decision]
---
# One status board owns the terminal

In rich mode every terminal write goes through a single status board, and no second cursor-owning widget
may exist while a stage is live. Stages overlap by design — the Gmail-bound participated-thread fetch runs
alongside the model-bound inbox skim, and later phases extract while other stages report — and
`@clack/prompts` bars are spinners that redraw relative to wherever the cursor stands, so two of them fought
over one line and stacked `17/344.` and `67/1500.` on a single bar. The board keeps one row per live stage,
repaints the block in place, inserts log lines above it, leaves one dim completion line per stage, and
degrades to plain lines rather than throwing if a render faults. clack's intro/outro/spinner survive only
for non-concurrent moments, guarded by `board.live`. Plain mode is untouched and byte-identical. Related:
[[Gotchas]], [[Architecture]].
