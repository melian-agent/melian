# Token telemetry: count every response in one decision

[Pull request #146](https://github.com/melian-agent/melian/pull/146), final cold-round finding `5bba4ac4a03abdd4`.

The receipt counter had no test with two recorded responses in one decision invocation. Two new cases report both responses, with zero or one further started request whose usage is lost. They check the stored attempt count, valid decision, exact summed usage and incomplete count. SQLite reopen preserves the entire settled telemetry record and printed spend.

Both cases pass against the existing correct counter. Removing `recorded++` makes their unmeasured counts 2 and 3 instead of 0 and 1. Doubling it makes those counts -2 and -1. Replacing it with `recorded = 1`, the finding's mutation, produces 1 and 2. Every mutation fails both cases; restoring production passes all 26 token telemetry tests.

No production behaviour, guard or stored shape changes. The append-only inventory and pass report under `tmp/` record the exact mutations and failed runs. This fix pass leaves the implementation plan unchanged.

The whole sandbox gate exits 1: 4,734 passed, 53 skipped and four process-table failures across 159 files. No test timed out. Formatting, types, dependency checks and the high audit threshold pass. The report lists all three ps-dependent skips and four failures. The host must rerun the whole gate outside the sandbox. Log: `tmp/token-telemetry-pass7-check.log`.
