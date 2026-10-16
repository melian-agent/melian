# Count the final model response in stage telemetry

[Pull request #135](https://github.com/melian-agent/melian/pull/135), pass 3, F2. Pi's assistant timestamp marks request start. The reader now adds the recorded response duration to completed and unanswered conversation ends. Legacy answers retain their timestamp and carry a missing-duration note.

Both slow faux probes failed before the fix: a 1,913 ms response read as 3 ms, and a 1,908 ms error response read as 0 ms. The missing-duration note also failed before the fix. The telemetry tests pass after it, including crash and reopen cases. Request-time reply factories replace the integration test's timestamp rewrite.

Nineteen manual mutations failed tests. They cover optional transcript data, message roles, duration arithmetic and fallback, note projection, both settled end paths, and the final form of F1's guard. `tmp/stage-telemetry-inventory.md` lists the proof; `tmp/stage-telemetry-pass3-report.md` holds outputs and gate results. F1 was committed as `8d700741`.

The first whole gate passed 4,362 tests and skipped 53; four process tests failed because the sandbox denies `ps`. The final whole gate is recorded in the pass report. The coordinator must run the gate and automatic mutation check on the host. No live model ran. The plan status remains unchanged.
