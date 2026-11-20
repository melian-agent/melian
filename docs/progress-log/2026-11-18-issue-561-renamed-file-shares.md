# Issue 561: a renamed file shares with the lenses its old path selects

Codex's adversarial review of [pull request #582](https://github.com/melian-agent/melian/pull/582) at 727d58bc found that the parity arm's shares selected lenses by each file's new path alone. The review selects through `Revision.paths()`, which names a renamed file by its old path too, so a lens covering only the old directory ran with no share of the file's lines.

`ParityArm.shares` now selects with both paths and counts each changed file once, when either path is selected. A test in `packages/evals/test/parity.test.ts` moves `src/x.ts` to `docs/x.ts`; before the fix the `src/**` lens had no share and the `docs/**` lens took all 1000 tokens, and after it they take 464 and 535. A rename within one lens's directory counts its lines once. Dropping either the old path from selection or the old-path match in the count fails the test. The `oldPath !== undefined` guard is equivalent: no selected path is undefined.
