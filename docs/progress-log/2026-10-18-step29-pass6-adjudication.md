# Step 29 pass 6: prove the remaining adjudication paths

[Pull request #144](https://github.com/melian-agent/melian/pull/144) adds two direct regressions for the final cold round.
An all-refuted defect drops an ordinary block beside a protected advisory.
A stored defect keeps an injection floor when its member exists only in `alsoReportedAs`.
Both input orders exercise the first case.

Three exact replacements survived before these tests: the false all-refuted condition, the empty rule array, and the member callback returning `undefined`.
Each now fails its named regression. Restored source passes 268 tests in six core files.
The installed Stryker instrumenter enumerated the grouped line in memory; it contains the array and callback replacements.
No production code, stored version or plan status changes.

The appended inventory and red/green logs are under `tmp/step29-mutation-inventory.md`.
The full-gate result, equivalent assessment and final CI state will be recorded in `tmp/step29-pass6-report.md`.
