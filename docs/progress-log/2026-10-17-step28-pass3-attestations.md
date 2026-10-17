# Step 28 pass 3: print each published round’s dismissals

[Pull request #142](https://github.com/melian-agent/melian/pull/142) returns attested dismissal snapshots through Publication.
Each snapshot names its revision and round. The CLI prints these, including a resumed older round’s distinct reports and reasons.
Repeated identical snapshots appear once. Explicit publication still prints the current ledger’s dismissals when no new review is needed.

The regression failed first because the older dismissal ID was missing from CLI output.
Tests cover posting and signed recovery, a resumed task, legacy metadata and repeat publication.
The publish task advances to version 4. A fixture recorded by version 3 and SQLite reopen prove migration and timing preservation.
The version-1 reopen test still proves legacy timing and writer trust.

Hand mutation details and the whole gate result are in `tmp/step28-pass3-report.md`.
