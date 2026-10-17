# Step 29 pass 5: explain the floor in persistent output

[Pull request #144](https://github.com/melian-agent/melian/pull/144) fixes F2 from the review of record.
A protected refutation appeared as a plain acknowledgement in the ledger and review summary.
The summary now shows each distinct floor headline. Ledger entries carry the full claim diagnostics through `prose`.
The notes name the judgement, reported severity, minimum and reason. Refutations say that a maintainer must still review them.

Both lowered and refuted scenarios failed before the fix on `5e006aa1`.
All 92 publication, ledger and trust-floor tests pass after it, as does type checking.
Removing the ledger notes, their escaping, or the summary headline fails both scenarios.
Showing a second summary note also fails, proving the headline bound.
The final whole gate and exact mutation evidence are recorded in `tmp/step29-pass5-report.md` and `tmp/step29-mutation-inventory.md`.
No stored shape or plan status changes.
