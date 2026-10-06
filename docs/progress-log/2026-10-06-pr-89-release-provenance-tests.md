# Release provenance guards

Confirmed fifth-round finding 1e5db9cf840edbd7 for [pull request #89](https://github.com/melian-agent/melian/pull/89).
Deleting both the draft and tag predicates leaves all three old release-verification tests passing.

The regressions keep publication time and asset digests valid while changing only draft status or the tag.
Both cases assert the exact verification error locally and in CI, with no network-skip notice.
Deleting both predicates fails both new tests. Deleting each alone fails its own test.
Each mutation restores the production script in a finally block.
The restored release-verification suite passes all five tests.

The final fifth-round gate passes 76 suites and 1,721 tests, with 50 skipped.
The first gate timed out three golden tests under load; each passed alone before the successful gate rerun.
