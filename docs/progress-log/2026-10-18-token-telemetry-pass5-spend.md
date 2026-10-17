# Token telemetry: pin successful eval spend

[Pull request #146](https://github.com/melian-agent/melian/pull/146), final-round findings 7e0650d7 and 05024a6b.

The success tests accepted arbitrary token counts and zero cost. Replacing either success printer's spend with literal `0 tokens, $0` passed all 16 output tests before this fix.

Lens and verifier callbacks now supply detached telemetry with 14 tokens/$1 and 28 tokens/$2. Success assertions pin those totals exactly. The unjudged verifier result has the second total, so one golden's record cannot stand for another.

Both literal-zero mutants fail the strengthened tests: three lens tests and two verifier tests. Mutants that print the first golden's 14 tokens/$1 for every golden also fail. Restored production sources pass all 54 tests across the output, live-reporting and triage suites.

The report and appended inventory under `tmp/` record every replacement and its failed test. This change strengthens tests only. The implementation plan stays unchanged and no comparison record changes.

The final whole sandbox gate failed only the same four process-table tests: 4,614 passed and 53 skipped in 441.45 seconds. No timeout failed. Lint, types, dependency checks and the high audit threshold passed. Log: `tmp/token-telemetry-pass5-check-final.log`. The report names every ps-dependent skip and failure; the host gate remains required.
