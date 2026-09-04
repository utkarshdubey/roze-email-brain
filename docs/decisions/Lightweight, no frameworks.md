---
title: Lightweight, no frameworks
tags: [decision]
---
# Lightweight, no frameworks

Own loop over `fetch` + zod; no agent SDK, no vector store, no graph DB. The terminal UI is the one
exception (`@clack/prompts` + `picocolors`), chosen because a package was explicitly requested; plain
output stays byte-identical when not on a TTY. Ranked retrieval uses Node's built-in SQLite when present,
adds no package or service, and retains the plain-file scanner for older runtimes.
