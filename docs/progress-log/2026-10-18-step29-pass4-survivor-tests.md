# Step 29 pass 4: prove the exact mutation survivors

[Pull request #144](https://github.com/melian-agent/melian/pull/144) adds six core regression tests for the host’s nine mutation findings.
Eleven candidate replacements first survived 199 tests at `07b2af9f`.
After the new assertions, every replacement failed exactly one test; 204 others passed.
The restored source passes all 205 targeted tests.

One case merges two refuted protected claims: only one minimum is visible, and the defect must still count.
Another mixes acknowledgement and advisory minima and compares every diagnostic line.
The remaining cases preserve original claims after imported proof, retain ordinary resolution without protected claims, and exercise claim-specific rule floors.
They change no production code or implementation-plan status.
A merged receiver also brings its highest severity; a claim’s ordinary counterpart must copy only the merged cause.

A finding ID names a line, so two entries hide further replacements.
The pass enumerated those lines through the installed Stryker instrumenter, without launching a runner.
All fifteen possible replacements on the grouped lines failed tests.
No equivalent survivor is claimed.
The appended inventory, exact replacements, failing test names and logs are in `tmp/step29-mutation-inventory.md` and `tmp/step29-pass4-report.md`.
The coordinator retains the cold host mutation run and model reviews.

The final whole gate exited 1: 4,640 passed, 53 skipped and the same four sandbox process failures.
No changed test or timeout failed. Three real-process tests skip because `ps` is denied.
The report names each skip and failure; the coordinator must rerun the whole gate on the host.
