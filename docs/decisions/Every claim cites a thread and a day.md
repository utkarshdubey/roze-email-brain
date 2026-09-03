---
title: Every claim cites a thread and a day
tags: [decision]
---
# Every claim cites a thread and a day

Every memory item, project, interest, and answer sentence cites `[t:<thread_id> <YYYY-MM-DD>]`, and the
day must head a real message in `evidence/threads/<id>.md`. Raw threads stay on disk so the offline
validator can prove every citation without Gmail or a model. The answer agent's audit sends a draft back
once when a citation is unread or undated, then shows a visible warning. Related: [[Query agent]].
