# Comparison adjudication, statistics, backlog, and export

Milestone 2 step 15 adds local comparison judgements with author identity, time, and replacement history. It keeps version 1 readable and leaves the review verdict untouched. Core's comparison objects compute recall, precision, misses, repeat clusters, golden debt, and the drain notice. The CLI reaches each operation and exports stored rounds as escaped markdown or JSON.

The [metrics decision](../decisions/2026-10-05-comparison-metrics.md) defines the arithmetic, date filters, and conservative local drain notice. The three skills carry one-line uses, and the Claude Code copy matches its source. Core, pipeline, and scripted CLI tests cover the objects and commands. A fixed markdown snapshot pins export.

[Pull request #72](https://github.com/melian-agent/melian/pull/72) carries this work. It is based on `compare-import`, [pull request #68](https://github.com/melian-agent/melian/pull/68).

Initial validation: `npm run check` passed with 1,059 tests. Review fixes pass 165 tests across eight focused Vitest files, `npx tsc --noEmit`, and `npx biome check packages scripts docs`; the full gate is reserved for the committing agent. No dependency changed.

Review fixes retain empty participants, skip pending recall, expose reasonless misses, reach earlier rounds, and preserve debt without `--golden`. Stats and backlog read documents without a harness; filters leave the drain clone-wide. Export uses bounded six-column tables and author names without emails. Backlog markdown prints a replacement section and never writes BACKLOG.md. Duplicate judgements name their target.
