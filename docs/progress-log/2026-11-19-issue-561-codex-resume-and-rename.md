# Issue 561: Codex's two findings on the merged head

Codex's adversarial review of PR #582's head after main's lens budgets merged, d26cf4ac, raised two findings, and both were real.

A parity resume narrowed by `MELIAN_EVAL_PARITY_MISSES` exited 0 when the misses it named were scored. A miss the results file still named might have no review, or only its committed arm, so an unfinished run read as finished. The run now stops, exit 3, while any miss the results file names lacks either arm. The stop reason names the miss to resume with. The new test in `packages/evals/test/parity.test.ts` stops a two-miss run after miss two's committed arm and resumes it narrowed to miss one. It failed on d26cf4ac with `expected +0 to be 3`, and it passes now. A full resume then exits 0, and the file no longer says stopped.

The probing route checked a probe lens against each changed file's new path only. It refused a lens narrowed to `src/**` on a file renamed out of `src/`, though a review selects that lens through the old path. The route now passes both paths, as `Revision.paths()` does. On d26cf4ac the new assertions in `packages/evals/test/probing.test.ts` failed with the refusal "reviews none of the changed files", and they pass now.

Mutants: the enumerator listed 16 over the two fix commits. One string literal is ignored by configuration, and the other 15 were each run by hand against their named test and killed. The `some`-to-`every` mutant survives a miss with no attempts at all, so the test stops on a miss whose committed arm alone finished.
