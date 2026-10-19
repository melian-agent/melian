# Step 23a pass 10: prove historical reads keep their verdict

[Pull request #152](https://github.com/melian-agent/melian/pull/152), finding `7a61c54150efb3cf`.

One CLI integration test decides a passing r1, adds a blocking finding, then decides r2 for the same revision. It reopens SQLite and reads r1 through `RoundReader.read` and `melian findings --round`. Both must return the passing verdict.

Hand-mutating the reader's final mapping to prefer the live verdict makes both assertions fail: r1 returns r2's blocking verdict. Restoring the source passes. No production change is needed.

All 35 CLI round tests pass. The whole gate records 4,967 passing tests, 53 skipped and four failures in tests that use `ps`. The sandbox denies process-table reads; the coordinator must rerun the gate on the host.
