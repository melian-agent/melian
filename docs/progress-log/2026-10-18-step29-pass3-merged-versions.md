# Step 29 pass 3: retain step 28’s dismissals

[Pull request #144](https://github.com/melian-agent/melian/pull/144) merges main at `748dfe37` after [pull request #142](https://github.com/melian-agent/melian/pull/142) landed.
Findings takes version 10: version 9 already records accepted dismissal triggers and proof.
Versions 8 and 9 read unchanged; versions 4–7 retain their evidence conversion.
Verdict 10 and published 8 remain the next versions after main’s 9 and 7.
Main’s publish task is already version 5, following step 28’s later fixes, and keeps its migration branches.
No task shape changes in this pass.

A fixture recorded by main’s own source at `748dfe37` proves version-9 findings survive SQLite reopen and a version-10 write.
Accepted triggers, affected proof and verifier lowerings survive together.
The earlier reopen tests remain.
A changed trigger or proof reopens the corresponding dismissal and restores the protected acknowledgement.
Fake GitHub publication tests cover lowered and refuted claims: failure, dismissal success, an unchanged push, then failure after changed content.

The version-collision regression first failed with “expected 9 to be 10”.
The version-9 migration regression also failed before the fix; both then passed.
Nine hand mutations failed their tests, including the version boundary, evidence conversion, dismissal content and acknowledgement status mapping.
The final whole gate passed 4,632 tests and skipped 53; four unchanged sandbox process failures keep its exit at 1.
Biome, type checking, dependency checks and the audit threshold passed.
The three `ps`-gated skips and four failures are listed in `tmp/step29-pass3-report.md`, with the version audit and mutation proof.
The coordinator retains the host mutation run and model review rounds; this pass runs no live model calls.
