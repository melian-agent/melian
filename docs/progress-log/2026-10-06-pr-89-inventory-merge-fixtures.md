# Keep caller fixtures on the merged review API

The first gate after merging main into [pull request #89](https://github.com/melian-agent/melian/pull/89) found four TypeScript errors. Two core calls passed advisory context in the new standards-source position. Two pipeline calls omitted records for a raw harness.

The fixtures now pass revision trust before advisory context and supply an empty deterministic check list for their lens-only tier. Their caller, coverage and repeat-review assertions stay intact.

The focused suites pass 83 tests. The full gate passes 86 files and 1,985 tests, with 50 skipped. Limiting Vitest to two workers through VITEST_MAX_WORKERS avoids the first gate's machine contention; repository test settings are unchanged.
