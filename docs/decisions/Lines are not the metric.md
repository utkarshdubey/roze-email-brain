---
title: Lines are not the metric
tags: [decision]
---
# Lines are not the metric

Automated simplification hit 50% line targets by packing (average line 59 → 107 chars, comments halved)
while removing only ≈ 11% of non-whitespace characters. Judge simplification by non-whitespace characters,
module boundaries, and whether a reader can follow a file in one pass; format at 120 columns, one statement
per line, why-comments kept. Related: [[Working conventions]].
