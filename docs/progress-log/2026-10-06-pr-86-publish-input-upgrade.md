# Legacy publication input upgrade on its object

[Pull request #86](https://github.com/melian-agent/melian/pull/86), Melian second-round finding 31d7c60faf5c4fbe, identified an inline stored-input migration. PublishInput now holds the stored task input and provides its static upgrade. The task's migration callback delegates to it. Current task creation serialises the same object.

The version-1 SQLite fixture still migrates to trusted writers, completes its original task and posts one review and one ledger. The second-round comparison records all four confirmed findings and both failing mutations. No design decision changes. The required-status rehearsal and switch remain pending.

The full gate passes: 57 test files, 1,456 passing tests, 50 skipped tests and zero audit vulnerabilities. No timeout rerun was needed. The report stays local at tmp/fix86b-report.md.
