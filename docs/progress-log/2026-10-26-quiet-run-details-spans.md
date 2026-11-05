# Keep decided spans after a failed rerun

Fix pass for [issue #213](https://github.com/melian-agent/melian/issues/213) and [pull request #221](https://github.com/melian-agent/melian/pull/221).

A failed review now keeps existing preparation spans when the revision still has a decided verdict.
Successful reruns replace them. A failure without a decided verdict or existing spans records its own spans.
No stored shape changes.

The CLI regression stores a decided review with a two-second preparation span, fails a second review of that revision, then publishes through fake GitHub.
Before the fix, its ledger showed the failed review’s short preparation row instead of two seconds.
After the fix, the ledger’s preparation row and summary retain two seconds.
The missing-spans, missing-verdict and successful-rerun cases also pass.
Both affected CLI files pass, 19 tests. All 12 fix mutants were applied individually and killed; none were omitted.
The [inventory](2026-10-26-quiet-run-details-spans-mutants.json) records each named failing test.

The host runs `npm run check`; this sandbox pass runs targeted files, Biome and TypeScript only.

Final verification covers all three fixes: 197 tests across 12 targeted files, Biome and TypeScript pass.
Restoring all three production files to `9897e7a0` reproduces seven assertion failures across the migration, check outcomes and span regressions; the unseeded control passes.
Restoring the fixes makes all eight selected cases pass.
The [final inventory](2026-10-26-quiet-run-details-final-mutants.json) contains all 85 mutants from the starting head, with source blob identities and final coordinates.
Every mutant was reapplied against the final source: 84 killed, one equivalent, none omitted.
The earlier fixes are commits `64fa6a42` and `dd70ed70`.
