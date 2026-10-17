# Publication takes version 9 after step 29

[Pull request #145](https://github.com/melian-agent/melian/pull/145) merges main at `942fe6c0`, which landed [pull request #144](https://github.com/melian-agent/melian/pull/144).
Main already published version 8 for trust-floor diagnostics. This branch now takes version 9 for resolution keys.
Findings and verdict documents retain main's version 10. The other shared definitions retain their versions and migrations.

Main's unchanged code at `942fe6c0` recorded two publication snapshots through fake GitHub.
They cover recorded and pending resolutions, trust-floor diagnostics and untrusted publisher attribution.
Both reopen tests failed with the version-8 collision, then passed through a version-9 write and another reopen.
Earlier reopen tests remain. The decision, design and package guidelines now name version 9.
The implementation plan is unchanged by this fix pass; the merge retains main's plan updates.

Mutation probes cover the collision, evidence migration, reply migration, recorded and pending resolutions, dismissal keys and attribution.
A surviving version-2 reply-boundary mutant prompted a fixture recorded through the unchanged version-2 publisher at `9367190c`.
Its new SQLite test fails under that mutant and passes restored. All 11 hand probes now fail.
The six focused suites pass 84 tests. The report records the full gate and sandbox process limits.

Report and mutation inventory: `tmp/orphan-thread-pass6-report.md`.

The first full gate found two conflicting test assumptions after merging step 29.
Its trust-floor summary test now posts the finding inline; a separate assertion retains this branch's carried-finding body details.
Both cases fail when the summary placement is removed. The 31 rendering tests pass restored.
The full gate was rerun after this test-only correction. No rendering behaviour changed.

The second full gate passed 4,824 tests and failed the four known sandbox process-table cases; 53 tests skipped.
Static checks passed. The gate did not pass as a whole, so the coordinator must run it on the host.
