---
title: Gotchas
tags: [operations]
---
# Gotchas (each cost real time)

- Gmail answers `400 Precondition check failed` for Google Chat items that listings still return: skip them
  (`-in:chats` on listings; skippable per-thread errors) instead of aborting a fetch.
- Gmail per-minute quota: a 403 pauses every worker for 61 s; exhausted retries skip the thread with a
  warning; the next generate resumes from the cache boundary.
- Windows refuses to rename a directory another process holds open (EPERM): the publish swap retries for
  about six seconds and rolls back on failure.
- A progress bar aborted a paid build: `RangeError: Invalid count value: -107`. Stage names repeat across
  phases, so `extracting`'s 54-thread bar was fed phase two's counts and advanced by 1 − 199, and
  `"█".repeat()` throws on a negative count. A bar is decoration on top of paid work: clamp every
  caller-supplied count, give a stage that reappears with a new total a fresh bar, and swallow a renderer
  that throws (the stage goes quiet) rather than letting it reach the concurrency helper.
- Two live `@clack/prompts` bars corrupted phase 1: one bar drawn with `17/344.` and `67/1500.` stacked at
  its right edge and the second label lost. Its bars are spinners that redraw relative to wherever the
  cursor stands, and phase 1 overlaps the participated-thread fetch with the inbox skim. The invariant:
  [[One status board owns the terminal]] — in rich mode every write goes through the board, and no second
  cursor-owning widget (bar, spinner, ad-hoc `\r` line) may exist while a stage is live.
- Days must be the user's days: automated senders stamp UTC; the offset timeline from sent mail fixes it.
- `resultSizeEstimate` caps at 201; count by paging. Substring entity matching filed "Rox" under "X": match
  whole words, names ≥ 3 chars.
- A rendered interest named "Claude" produces `interests/claude.md`, which a case-insensitive filesystem
  treats as `CLAUDE.md`.
- An unanchored `brain*/` in `.gitignore` also ignores `src/brain/`; anchor it (`/brain*/`).
- In zsh, `read … path` inside a loop clobbers `PATH`.
- The mini model at medium reasoning can spend its whole output cap reasoning and return nothing; the
  cached-call layer retries once at low.
- `codex exec` here: `--skip-git-repo-check -m <model> --config model_reasoning_effort=<level> --sandbox
  workspace-write -C <dir> "<prompt>" </dev/null` (no `--full-auto`).
