---
title: Gmail usage is measured
tags: [decision]
---
# Gmail usage is measured

Each outbound Gmail fetch attempt is counted by resource kind, including HTTP and transport retries:
profile 1 quota unit, listing page 5, message read 5, and thread read 10. OAuth token refreshes and failures
before a Gmail fetch are outside that count. `generate` prints total units, requests, the thread/message/list
breakdown, and the wall span from the first Gmail attempt through the last, so cold-build speed work can be
compared from one line. No real-mailbox improvement is claimed until the coordinated before/after run.
