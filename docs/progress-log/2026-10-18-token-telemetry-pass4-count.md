# Prove the missing-request boundary

[Pull request #146](https://github.com/melian-agent/melian/pull/146), pass 4, addresses finding b878664f.
The round groups two survivors on telemetry.ts line 381 and prints only the replacement true.
The installed Stryker instrumenter enumerated all five replacements on that line in memory.

The old telemetry suite passed with the true replacement.
New detached-reader tests cover zero, one and two missing requests.
All five replacements fail: true and >= 0 invent a zero marker; false, <= 0 and the empty object drop a positive marker.
Restoring production code passes all 37 telemetry tests. No equivalent is claimed.

The appended inventory names each replacement and failing test.
The report under tmp/token-telemetry-pass4-report.md records red and green logs, the whole gate and exact-head CI.
No production code changed. The implementation plan stays unchanged for this fix pass.
