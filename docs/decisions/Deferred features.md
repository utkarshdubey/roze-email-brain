---
title: Deferred features
tags: [decision]
---
# Deferred features

Write-back to Gmail, background enrichment, incremental processing of new mail after the initial build,
and an interactive chat mode are out of scope per the brief and are deliberately absent; the pipeline
already resumes from caches, so incremental builds are cheap when they are wanted.
