# Builder inventories execute trusted checkout code

Amends: [Builder mutant inventory](2026-10-21-builder-mutant-inventory.md), execution boundary

Problem: the enumerator imports Melian modules and its helper from the checkout. Reading source blobs from Git does not pin that implementation.

Choice: the builder runs the checkout’s own code under the same trust as running its tests. Use the enumerator on trusted heads only, never a fork’s head. The script runs no tests or process listing. Its empty scratch directory prevents Babel configuration loading; it does not isolate the imported implementation.

A later use from a review needs a pinned copy outside the reviewed head. That work needs its own decision and is deferred.
