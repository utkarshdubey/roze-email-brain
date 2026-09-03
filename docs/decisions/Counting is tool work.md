---
title: Counting is tool work
tags: [decision]
---
# Counting is tool work

"How often" and "how much" questions are answered by tallying every matching row (`group_by`,
`amounts=sum`, `from`/`to`) over the per-year lists and the typed transactions table, never by sampling a
few read threads. Dates, timezone, day validation, tally grouping, and period filtering are code, not the
model. This replaced a receipt-specific prompt paragraph with a generic operator.
