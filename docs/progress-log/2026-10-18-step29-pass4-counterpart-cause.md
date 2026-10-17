# Step 29 pass 4: keep refutation within the merged cause

[Pull request #144](https://github.com/melian-agent/melian/pull/144) fixes Codex’s protected-refutation finding.
A pre-existing P0 or P1 merged with an introduced report stayed silent before verification.
Refuting the protected claim then borrowed its old pre-existing-important floor and raised the defect to advisory.
The ordinary counterpart now takes the merged cause while keeping its own reported severity and rule.
No new branch or stored shape is needed. The implementation plan’s status stays unchanged.

The two-case regression first failed with `expected 'findings' to be 'passed'` on `ea2ed223`.
Both cases pass after the fix, alongside the merged-resolution tests: 80 tests in all.
Removing the cause assignment makes both regressions fail again.
The inventory and run logs are under `tmp/step29-mutation-inventory.md` and `tmp/step29-pass4-report.md`.

The whole gate exited 1: 4,634 passed, 53 skipped and four known sandbox process failures.
Three real-process tests skip when `ps` is denied; the report names them and the four failures.
No timeout or changed test failed. The coordinator must rerun the whole gate on the host.
