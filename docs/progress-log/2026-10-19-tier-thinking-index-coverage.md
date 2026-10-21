# Keep repository-index coverage across amendments

[Pull request #157](https://github.com/melian-agent/melian/pull/157) adds an active amendment to the reasoning-capture decision.
CI exposed a stale coverage assertion: it required a bare `[ACTIVE]` label for every active decision.

A committed 103-decision fixture reproduced the failure before the fix.
The helper now accepts the amendment annotation while requiring each complete path, full title and active state.
Three fake renderings change the path, title or active state; each must be rejected.
The full decision-file suite passed all 184 tests.
Mutations that match only the path, only the title, or any state each failed the new test.

This changes test coverage alone. The renderer and the amendment declaration remain intact.
The repository-scale check reads HEAD, so an uncommitted decision's new annotation does not appear in that check.
Keep an amended committed fixture beside it, rather than relying on a pre-commit whole-gate run.
Failing, passing and mutation outputs are in the branch's scratch report directory.
