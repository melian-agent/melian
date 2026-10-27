# 2026-10-26: third fix pass on the graph tools at 174f90b9

Melian's review of [pull request #207](https://github.com/melian-agent/melian/pull/207) found two gaps at 174f90b9.

- `fe123808` fixes finding `da01f9a2367c1793`. File-set search keeps each file's share and caps the returned total at `maxMatches`. Earlier files take priority when the file count exceeds the bound. A file whose matches are withheld is marked truncated.
- `0047f8a4` fixes finding `c6f75303c741198d`. The pipeline guideline now distinguishes the first verified graph-cache read from later reuse of the parsed snapshot. Removing a cache entry leaves a memoised snapshot available. [Issue #224](https://github.com/melian-agent/melian/issues/224) tracks keying the memo by the snapshot's own ID.

The match-limit tests ran before the fix. `npx vitest --run packages/core/test/revision.test.ts -t 'caps .* matching files'` exited 1: four failed and two passed. Limits of 1, 10 and 0 returned excess matches. Both at-bound cases passed. The tests assert each complete result with `toEqual`, including the case with 65 matching files and a limit of 10.

After the fix, `npx vitest --run packages/core/test/revision.test.ts` passed all 39 tests. `npx vitest --run packages/pipeline/test/graph-tools.test.ts` passed all 19 tests. Targeted Biome checks passed. The documentation was checked against `graphOf` and `GraphMemo`.

Enumeration with `node scripts/enumerate-mutants.mjs 174f90b9...HEAD --json --limit 10000` lists nine mutants and omits none. Every mutant was classified as `new-test`, applied alone and killed by its named test. Six were killed by the two-file, one-match case. Three were killed by the one-file, one-match case. There are no equivalent or surviving mutants. The complete inventory, scratch runner and per-mutant logs remain in the builder's scratch directory.

The builder ran only targeted test files. The host must run the full gate.
