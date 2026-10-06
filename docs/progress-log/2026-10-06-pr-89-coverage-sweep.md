# Third-round coverage regressions

For [pull request #89](https://github.com/melian-agent/melian/pull/89), confirmed be3f085457b4f5c7 and 40a6f2a824831fd3.
Deleting the target-name guard and forcing base reads to head passed the old suites.
Both mutations now fail. A different resolved target delivers no group and an advisory.
A delivered base read credits base lines and hunks without marking head as read.

The four-file sweep found 100 further observable mutation weaknesses.
The count is per guard, predicate, selector or limit mutation, rather than per if statement.
Tests cover caller omissions, runner failures, transcript boundaries, all graph gap causes, worker limits, cache authentication and positive byte-limit boundaries.
There were 234 baseline trials. Of 105 surviving behaviours, 102 now fail regression tests.
Three removals remain equivalent or unreachable: receipt type checking, expanded-entry size after the gzip cap, and safe integers after bounded octal validation.
The guards remain. The local report lists each trial and the three proofs.

An inverted rejection guard can fail on valid fixtures without testing its rejection.
The pipeline guideline now requires deleting it too, or proving the deletion equivalent.
No provider or real Enola release ran.

The final gate passed 73 test files and 1,695 tests, with 50 skipped and no vulnerabilities.
No test or registry timeout occurred. All four production files equal the starting source.
Fresh external reviews and landing remain.
