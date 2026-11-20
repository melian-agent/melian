# Issue 561: five fixes from the third reviews of the parity run

Codex's third adversarial review of [pull request #582](https://github.com/melian-agent/melian/pull/582) and the review of record, both at 1dd2d5f1, found five defects that need no new mechanism.

- Two misses with one name collapsed into one identity, and the run skipped the second. `Miss.load` now refuses a misses file that names a miss twice.
- Two scoped variants of one lens each took that name's whole share, so the parity arm could spend more than the committed arm's total. Shares are now keyed by lens and scope, and each variant takes its own share of the lines it selects.
- A committed review whose lenses spent nothing crashed on a parity total of 0. The parity arm is now recorded as not run, with that reason.
- A resumed run that finished every review still exited 1, because the attempts an earlier stop left carry no score. The exit code now counts only finished attempts.
- A committed review that ran but failed to be judged skipped the parity arm, as if it had no review. An attempt now says whether its review finished, and only one that did not skips the parity arm.

The run also resolves each miss's changed paths while it checks the misses, before any review, so a git failure can no longer sit between a review and its save.

Six tests reproduce these, in `packages/evals/test/parity.test.ts` and `packages/evals/test/probing.test.ts`. Against 1dd2d5f1, each failed for its reported reason: the duplicate loaded, the variants shared 666 and 333, the run threw "The parity arm needs a positive total, not 0", the resumed run exited 1, the parity arm was never called, and "git failed" escaped the run. All pass now. Ten hand mutants of the new lines fail their named tests, among them both bounds on the zero total and both operands of the exit rule. A mutant forcing an operand of the skip rule survived: an attempt without a review always carries an error, so the operand was dropped.
