# Prove incomplete-usage spacing

[Pull request #146](https://github.com/melian-agent/melian/pull/146), pass 4, addresses finding 9dd4d584.
The exact MethodExpression replacement removes trim from the stage’s incomplete-usage marker.
It adds a second space, so it is not equivalent.

The original telemetry suite passed with that mutation.
The revised exact-rendering test fails with the extra space and passes after restoring the source.
Its cases cover absent, zero and one missing request. All 34 telemetry tests pass.
No production code changed. The mutation and both runs are recorded in tmp/token-telemetry-pass4-report.md and the appended inventory.
The implementation plan stays unchanged for this fix pass.
