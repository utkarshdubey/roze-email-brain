---
title: Gotchas
tags: [operations]
---
# Gotchas (each cost real time)

- Gmail answers `400 Precondition check failed` for Google Chat items that listings still return: skip them
  (`-in:chats` on listings; skippable per-thread errors) instead of aborting a fetch.
- Gmail per-minute quota: a 403 used to pause every worker for 61 s; on an account whose real cap is ~1,500
  units a minute that ran a cold build at 4 reads/s (30 min for 4,600 threads). The client now learns the cap
  from a sliding one-minute window ([[Costs and caching]]). Exhausted retries still skip the thread with a
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
- A build longer than a Google access token (60 min, not extendable) used to die on an unretried 401: the
  client held one token string for its whole life. It now asks a token source before every request, which
  renews early, once more on 401, and saves the result. An OAuth app in Testing status still expires refresh
  tokens after 7 days, so `roze auth` is needed weekly until the app is published.
- `search_memory` used to keep the first ten matching rows of a year list in file order (newest first) and
  rank afterwards, so any term with more than ten hits in a year silently lost its older threads. The share is
  now taken after ranking.
- Days must be the user's days: automated senders stamp UTC; the offset timeline from sent mail fixes it.
- `resultSizeEstimate` caps at 201; count by paging. Substring entity matching filed "Rox" under "X": match
  whole words, names ≥ 3 chars.
- A rendered interest named "Claude" produces `interests/claude.md`, which a case-insensitive filesystem
  treats as `CLAUDE.md`.
- An unanchored `brain*/` in `.gitignore` also ignores `src/brain/`; anchor it (`/brain*/`).
- In zsh, `read … path` inside a loop clobbers `PATH`.
- The mini model at medium reasoning can spend its whole output cap reasoning and return nothing; the
  cached-call layer retries once at low.
- Promotion decisions are cumulative but their sender-line input is paid and versioned. A format warning
  means the old decisions remain active; move the named `promotion.json` aside before re-auditing them.
- `codex exec` here: `--skip-git-repo-check -m <model> --config model_reasoning_effort=<level> --sandbox
  workspace-write -C <dir> "<prompt>" </dev/null` (no `--full-auto`).
