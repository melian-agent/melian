# Step 29 pass 6: prove ledger line ranges

[Pull request #144](https://github.com/melian-agent/melian/pull/144) adds a multi-line ledger regression.
Replacing `end === start` with `true` first survived all existing ledger tests.
The new test checks the complete ledger finding line, including `7-9`.
It fails under that exact replacement and passes after restoring the source; all 64 ledger tests pass.
Checking only that the body contains the range would pass through the agent prompt and miss this defect.

The pass accounts for all five final-round findings: five exact replacements are killed and one is equivalent.
The grouped rule-array line contains the empty array and the member callback returning `undefined`; both fail their new test.
The installed Stryker instrumenter enumerated the replacements in memory.
No production code, document version, dependency file or plan status changes.

Red/green evidence and the inventory are under `tmp/step29-pass6-report.md` and `tmp/step29-mutation-inventory.md`.
The equivalent's full reasoning is in `tmp/step29-equivalents.md`.
The coordinator must rerun the whole gate on the host after this sandbox pass.
