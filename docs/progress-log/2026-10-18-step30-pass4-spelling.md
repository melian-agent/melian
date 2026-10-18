# Step 30 pass 4: refuse filesystem aliases

[Pull request #147](https://github.com/melian-agent/melian/pull/147) follows the filesystem authority ruling.
WorktreeSource compares each component with its actual directory entry name.
RevisionSource already reads exact Git names and remains unchanged.
The three Unicode probes failed first on APFS, then passed with the refusal.
Directory-read tests exercise the same comparison on case-sensitive hosts.
Existing ASCII alias tests now expect absence and retain their notice assertions.

The local report and mutation inventory are `tmp/step30-pass4-report.md` and `tmp/step30-pass4-inventory.md`.
The coordinator runs the host gate and cold mutation check where the sandbox denies process inspection.
The implementation plan stays unchanged during this fix pass.

The affected run passed 158 tests. M57–M62 all failed assertions.
The whole gate passed 4,752 tests and skipped 53, with four known sandbox process failures in three files.
Its exit code was 1; lint, types, dependency checks and the audit threshold passed.
Three skipped tests need `ps`; the report lists them and the four failures.
Commit: `fix(core): refuse aliased worktree paths`.
