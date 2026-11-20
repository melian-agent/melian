# Issue 561: Codex's two checkout findings on 2e9d4d09

Codex's adversarial review of 2e9d4d09 raised two findings on `checkoutCommit` in `packages/evals/src/parity.ts`. The coordinator directed that both be fixed test-first before the push, with no second Codex run.

The documented command wrote the results file inside the checkout, and each review added a store beside it. `checkoutCommit` refuses a checkout with untracked files, so the run's own output made every resume fail as dirty. A misses file inside the checkout blocked even the first run. A run now refuses a results or misses path inside the checkout before any model. It names the path, through a symbolic link or not, and the documented command keeps both under `$HOME/melian-parity/`. The new `measureParity` test stops a run and resumes it with both files beside the checkout, then names each inside it. On 2e9d4d09, the run with its results inside the checkout started and stopped with exit 3, where it should refuse with exit 2.

`checkoutCommit`'s git calls inherited `GIT_DIR` and `GIT_WORK_TREE`, so a results file could record another repository's commit. They now run in core's git environment, as a miss's commits do. The new test points both variables at a second, dirty repository; on 2e9d4d09 it failed with that repository's untracked file.

Mutants: the enumerator listed 27 over the fix commit. One hand-written mutant drops the git environment. All 28 were run by hand against their named tests, and all were killed. The 29th, `!isAbsolute(from)` forced true, is equivalent on POSIX, where the relative path between two absolute paths is never absolute.
