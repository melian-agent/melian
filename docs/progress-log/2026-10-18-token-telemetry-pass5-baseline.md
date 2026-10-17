# Token telemetry: refuse incomplete triage baselines

[Pull request #146](https://github.com/melian-agent/melian/pull/146), final-round finding 28a633a4.

A fake-provider regression completes golden A, fails golden B on pass two, then compares a complete run against the saved file. Before the fix it reports a false regression. Version-2 measurement JSON now marks completion explicitly; comparison refuses an incomplete baseline before computing differences. An old-writer fixture proves unversioned measurements reopen and remain comparable.

The failing-first run records `worse` instead of `incomparable`. Both eval test files pass after the fix. Hand mutations cover the completion marker, its defaults, serialisation and refusal guard. Logs and exact replacements are in `tmp/token-telemetry-pass5-report.md` and the appended `tmp/token-telemetry-mutation-inventory.jsonl`.

The design and eval guideline document the completion contract. The implementation plan stays unchanged for this fix pass. No comparison record changes. The coordinator must run the host gate and cold mutation check; this task cannot inspect the process table or call live models.

The whole sandbox gate failed only four process-table tests: 4,614 tests passed and 53 skipped. No timeout failed. All 15 hand mutations failed the selected tests; both restored eval suites passed. The gate log is `tmp/token-telemetry-pass5-check-baseline.log`.
