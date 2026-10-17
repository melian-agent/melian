# Step 29: propose the trust floor before implementation

[Pull request #144](https://github.com/melian-agent/melian/pull/144) is a phase-1 draft for an attacking review. Commit `72470e04` adds the exact proposed decision, planned design wording and regression tests. No production code or dependency changed. Step 29 remains unchecked until implementation and review finish.

The proposed [decision](../decisions/2026-10-17-trust-floor-exact-rule.md) supersedes the earlier step-29 decision and restates its surviving clauses. Lowering still changes severity. A protected lowering or verifier refutation keeps an acknowledgement for a maintainer. Classification reads original claims and root approval-path policy, not a model's prose. The decision covers merged members, refutation, dismissal, step 28's status rule and visible reasons.

The motivating case is `73ad09e0` from round nine of [pull request #125](https://github.com/melian-agent/melian/pull/125): P2 lowered to P3 plausible, then found again by the review of record. F4 of the attack on [pull request #142](https://github.com/melian-agent/melian/pull/142) supplies the refutation case.

The targeted run has 31 tests: 22 fail for the missing floor or explanation, and nine controls pass. The cold-run test first confirms that the existing lowering fence accepts P2 to P3, then fails on advisory resolution. Refutation tests fail on the absent acknowledgement. Hunk tests assert the merge on real zero-context diffs before failing on resolution. The tests remain ordinary red tests for phase 2. Type checking passes.

The first whole gate failed: 26 failed, 4,497 passed and 53 skipped. Twenty-two failures are the intended regressions. Three unchanged process tests report `ps failed: undefined`; the Codex sandbox denies `ps`. One unchanged mutation-runner test expects `invalidOutput` and receives `toolFailed`. See the local report for the whole-gate rerun. The coordinator must also run the gate on the host, as every Codex pass requires.

No production guard changed, so no implementation mutation is claimed. The decision lists the mutation inventory owed by phase 2. No live models, external reviews or Melian rounds ran. The coordinator attacks the exact rule before authorising implementation. The local report and complete test output are under `tmp/step29-phase1-report.md` and `tmp/step29-phase1-tests.log` in the step-29 worktree.
