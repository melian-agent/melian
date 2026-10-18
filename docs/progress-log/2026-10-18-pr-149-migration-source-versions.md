# Migration source-version coverage

[Pull request #149](https://github.com/melian-agent/melian/pull/149) audits the
three migrations that accept more than one earlier version without reading
`fromVersion`. Each conversion is identical for its accepted versions.

Adjudication task version 3 preserves both earlier inputs and adds the same
legacy timing marker. Existing recorded reopen tests cover versions 1 and 2,
including their different snippet and hunk merging results. Check task version
3 does the same conversion for versions 1 and 2; the version-2 bump changed its
result record. Review-index version 3 preserves both older documents as stale
entries. Version 1 keeps head-only keys; version 2 keeps base/head keys. Neither
old selection includes today's scrutiny-level key.

Commit `34513491` adds the missing check version-1 fixture and SQLite reopen
test. Commit `f4c99fe8` adds recorded review-index versions 1 and 2 and tests
that preserve every field through migration, a current-version write and
another reopen. Each fixture came from the last writer before its version
bump, in a detached scratch worktree with that commit's locked dependencies.
The fixture README names the commits and recording scenarios. The sandbox
refused worktree metadata writes in the shared clone, so capture used detached
worktrees in a temporary local clone.

All 13 reopen tests pass. Type checking passes. Five manual mutations fail the
relevant tests: dropping check input, removing its legacy timing marker,
erasing review-index entries, removing adjudication's timing marker, and
discarding its changed-file ranges. Both adjudication source versions and
both review-index source versions fail the relevant loss probes. No runtime
branch or stored version changed. This coverage work changes no design
decision or implementation-plan status.

The builder reviewed the branch diff and found no defects. Whole-gate and CI
results, sandbox exclusions and the complete mutation inventory are recorded
in `tmp/migrations-report.md`. A host gate remains necessary because the
Codex sandbox denies `ps`. The task forbids live model calls, so the
coordinator owns the adversarial review and Melian rounds before readiness.
