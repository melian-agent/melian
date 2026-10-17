# Check ownership before resolving an edited root

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 4, closes the remaining addressed-thread ownership bypass.
The first ownership fix checked the parent review only when the finding marker matched.
A removed marker or another finding's marker could still reach thread resolution.
Four probes failed with thread 2 resolved instead of untouched. Two positive probes preserve resolution within an owned review.

The existing parent-review proof now runs before both the edit and skip-edit paths.
The fix removes three source lines and adds no mechanism.
The restored run passed 98 tests; mutations of the proof and both edit decisions fail.
The decision's as-built section now covers resolution after marker removal.

The first whole gate passed 4,694 tests and skipped 53. Four known ps-dependent tests failed; no timeout failed.
The final whole gate follows this fix and is recorded in `tmp/orphan-thread-pass4-report.md`.
