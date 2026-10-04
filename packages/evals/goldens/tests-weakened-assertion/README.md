# tests-weakened-assertion

Seeded from finding A2 of the [comparison record](../../comparisons/2026-10-03-pr-21.md) for [pull request #21](https://github.com/melian-agent/melian/pull/21): the skills test checked only commands that began with `melian`, so a skill could run any other executable and pass. The record marked this finding No for a golden. Recast as an edit: the record's test was new and checked only `melian` commands from the start, and here the head narrows an existing assertion to them.
