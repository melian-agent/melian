# Mutant enumeration lists set-aside paths; path patterns get per-test coverage

[Pull request #165](https://github.com/melian-agent/melian/pull/165), fix pass 1, after Melian round one.

`scripts/enumerate-mutants.mjs` dropped configuration, signal-sending and comma-named production files with a bare `continue`, so they appeared in neither `mutants` nor `unmutated`. They now appear as unmutated with the host check's own reasons from `mutationUnmutated`. With the new expectations, six of the script's tests failed on a7798c70 with `unmutated: []`; all nineteen pass after the fix. Nine hand mutations of the new branch each fail a test. Fix commit: 43dc4eb4.

Sixteen mutants of `mutation-paths.ts` survived because its patterns and sets are built at module load, which Stryker counts as outside any test. The only test reaching them from inside a test reloads modules for another reason and asserts nothing about paths. `packages/pipeline/test/mutation-paths.test.ts` loads the module inside each test with `vi.resetModules()` and `vi.importActual`, and each of the sixteen fails one of its tests by hand. A host Stryker run confirms the coverage. Test commit: 4262286d.
