# removed-behaviour-dropped-error-path

Seeded from finding 14 of the [comparison record](../../comparisons/2026-10-03-pr-12.md) for [pull request #12](https://github.com/melian-agent/melian/pull/12): every standards read failure counted as absence, so a permission error dropped a standard silently. Recast as a deletion: the record's reader counted every failure as absence from the start, and here the head deletes the rethrow that let only a missing file read as absent.
