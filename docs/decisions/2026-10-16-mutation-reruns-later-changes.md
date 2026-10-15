# How the mutation check reruns only later changes, as built

Supersedes: [the mutation decision](2026-10-08-mutation-testing-as-a-static-check.md), only for its incremental cache: the `incremental: true` setting's line, and the paragraphs "Incremental results across runs" and "Cost". Every other clause of the mutation decision stands as written.

The rerun decision, `2026-10-15-mutation-reruns-later-changes-only.md` from [pull request #122](https://github.com/melian-agent/melian/pull/122), replaces that clause. What the clause said that still holds is restated below. This file records the choices the rerun decision leaves open.

Problem: the rerun decision says what may be reused and when, not where the review target comes from, what the partition stores, or how a whole-suite repeat and the notes behave once results carry across heads.

## The review target is the changeset ID

The changeset ID already names a review target independent of its head. A pull request's is a hash of its provider, repository and number. A branch range's is a hash of the range mode and the canonical names of both sides, so `origin/main...HEAD` on one branch gives the same ID at every head. A range that names a bare commit hashes the commit, so it gets an ID per head: it runs cold at each new head and warm only on a rerun of the same one, as the rerun decision requires. The check task already stores the changeset, so a task a crash left pending resumes with its target. A caller of `runStaticTool` that names no target shares nothing: the head stands in for it.

## The partition stores the judged head and its leave

`<cache>/mutation/<identity>/partition.json` holds `{ version: 3, head, trust, report }`: the last judged head, the leave its tests ran under (`writer` or `reviewer`), and Stryker's incremental report. One file, replaced by one rename, so the head and the report never come from two runs. The identity hashes the review target, the base, the base-policy commit, the Stryker version and the installation identity, with the identity version 3; the head and the mutate entries are not in it.

The leave is the host's decision for the run, `StaticRunInput.headCode`, which the check task takes from `WriterTrust`. A run reuses the partition only when the recorded leave equals its own. A partition with any other value, or none, starts cold. The ancestor test is `git merge-base --is-ancestor <judged> <head>`; any exit but 0 starts cold.

A run also starts cold when code Stryker's incremental mode does not read changed since the judged head. Stryker diffs only the files it mutates and the test files it ran, the report's `testFiles`. Problem: a change anywhere else can change what a reused kill meant, and Stryker would never see it. Example: a head that edits `vite.config.ts`, a setup file under any name, or a test helper so that a strong test no longer asserts leaves every earlier kill reused. The first version listed configuration and setup files by name, and the second round of review found three names it missed. Solution: list `git diff --name-only --no-renames` since the judged head, and start cold on any JavaScript, TypeScript or JSON file that is neither mutated in this run nor a test file in the report, unless it is named as a test (`.test.` or `.spec.`), which Stryker will see. A production file changed since is in the pull request's diff, so it is mutated, unless the check sets it aside, and then the run starts cold. Prose and other files do not count. A failed listing starts cold too.

A run that starts cold says why in its notes. The reasons read:

- "this review target has no earlier judged head";
- "the run that judged ... was trusted as ..., not as ...";
- "the last judged head ... is not in this head's history, which was rewritten";
- "... changed since the last judged head ..., and Stryker's incremental mode does not read it".

## What Stryker reruns, as read in its code

Melian still mutates the whole pull request's changed lines; Stryker's incremental mode decides which results stand. Stryker 10.0.0's `IncrementalDiffer` sits in `node_modules/@stryker-mutator/core/dist/src/mutants/incremental-differ.js`. It reuses a result only when all of these hold:

- The mutant's code is unchanged, by a text diff of the old and new file.
- For a killed mutant, a test that killed it is unchanged, by a diff of its test file, name and position.
- For a survivor or an uncovered mutant, no test was added to those that cover it. The dry run still runs the related tests to learn coverage, so only the mutant runs are saved.

A test with the real Stryker in `packages/pipeline/test/mutation-real.test.ts` proves it on four heads of one target. A change to line 50 runs line 50's two mutants and reuses line 10's survivor. A change to the test that kills line 50's mutants runs them again. A head that changes neither reuses all three. Each head still reports the line-10 survivor: Stryker reports reused mutants beside those it ran, so the review's result covers the whole pull request. A survivor whose line a later head takes out of the diff is dropped, because findings come only from changed lines.

## A whole-suite repeat starts from the earlier head

A related run that fails or reports `NoCoverage` repeats with the whole suite, and [the selection decision](2026-10-12-mutation-test-selection-asks-vitest.md) has the repeat discard the related run's results. It now starts from the last judged head's results instead of from nothing: the stage writes a second copy of the earlier report, and the repeat restores it. Without that, any head whose related run reported `NoCoverage` would run cold.

## The notes count what was reused

"Stryker reused 1 of 3 mutant result(s) from bb98d3366f87, the last judged head, and ran 2." The counts come from Stryker's "Incremental report" log line, read from the attempt that decided the result. The head's tests write to the same log, so the counts are a note and decide nothing.

## What still holds from the superseded paragraphs

The head's tests never see the cache: the run writes staged copies in its scratch. Melian publishes after a successful run, only if no later review has taken the revision (`holdsAuthority`). The published report must be a regular file within 16 MiB, not a symlink, and parse as JSON; otherwise the partition keeps what it had. Reads refuse symlinks and files over the bound, with 1 KiB more for the partition's wrapping. An unreadable, oversized or malformed partition is removed before Stryker starts. The scratch sweep removes dead partial writes and keeps completed partitions. The installation identity is unchanged: a digest of each lockfile the checkout has, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock` or `bun.lockb`, the resolved versions of Stryker core, its Vitest runner and Vitest, the Node runtime version, and the selection version. Stryker reuses a kill by test identity and the linker supplies the checkout's dependencies, so a dependency change starts cold even at an identical head. A version-one or version-two partition is never read, and a reopen test reads one written by each earlier version's code.

## What it gives up, beyond the rerun decision

- A pull request reads policy from its base branch's tip, which moves whenever `main` takes a commit. Keying by the base-policy commit, as the rerun decision requires, makes the next push after such a move cold even when the merge base is unchanged. A branch range reads policy at its merge base and is not affected.
- Concurrent runs of one target each publish their own head, and the last to finish wins, with one exception. Problem: a run of an older head, such as one a crash left pending that a later review resumed, could finish after a newer head's run and put the older results back, so the next head reran everything the newer one had judged. Solution: a run does not publish over a partition whose head has its own head in its history. The read and the rename are not atomic, so two runs finishing in the same instant can still interleave.
