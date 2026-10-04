# removed-behaviour-dropped-guard

Seeded from finding 2 of the [comparison record](../../comparisons/2026-10-03-pr-12.md) for [pull request #12](https://github.com/melian-agent/melian/pull/12): the directory walk never ended when the repository root did not match, and ran out of heap. Recast as a deletion: the record's walk never had the guard, and here the head deletes it.
