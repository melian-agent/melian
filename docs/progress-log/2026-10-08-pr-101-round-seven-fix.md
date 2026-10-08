# Pull request 101: round-seven fix

Commit "test(pipeline): prove every shared-boundary scope is retained" addresses finding `52f5b1497f08a909` from Melian's seventh round on [pull request #101](https://github.com/melian-agent/melian/pull/101). Two regressions edit three nested callables' shared opening or closing line and assert all three spans. Appending `.slice(0, 1)` to the boundary filter failed both tests: each lost its middle callable. The mutation was restored, and the test file passed all 72 tests. The full gate passed: 107 test files, 2,900 tests passed and 50 skipped.
