# One mutation target selection for the host check and the enumeration script

[Pull request #165](https://github.com/melian-agent/melian/pull/165), fix pass 2, after Melian round two.

Two rounds each found a changed production file that `scripts/enumerate-mutants.mjs` dropped but the host check reports as unmutated: configuration, signal and comma paths in round one, then binary and non-UTF-8 files, which `Revision.diffLines()` omits. The class is the script re-deriving the host check's selection. `MutationTargets.select` in `packages/pipeline/src/mutation-paths.ts` now owns it: the changed ranges, the files set aside with their reasons and notes, and the binary or percent-encoded files. `MutationRun` and the script both call it, each with its own production predicate; `MutationRun.judges` reads it too. The core reasons are passed in, because the script runs under plain Node, which resolves `@melian-agent/core` to an unbuilt `dist`.

The new script test, a base `.gitattributes` marking `src/a.ts` as `-diff` beside a production file named in Latin-1, failed on 86547ef4 with `unmutated: []` and passes after the change. Two new host tests pin the notes and unmutated results for every set-aside kind and a binary file; both passed before and after the move. All 71 mutants on the changed lines that Stryker does not ignore fail a test by hand. Fix commit: e32d8f61.
