# Merge triage, ledger and verifier

Date: 2026-10-06

Merged [pull request #62](https://github.com/melian-agent/melian/pull/62) at 5b79a4e into [pull request #80](https://github.com/melian-agent/melian/pull/80). Kept the ledger from [pull request #73](https://github.com/melian-agent/melian/pull/73) and sandbox wrapper from [pull request #74](https://github.com/melian-agent/melian/pull/74).

Adjudication keeps atomic verifier-refusal cleanup and excludes ledger details from its attachment key. Details record the verifier in the manifest and keep settled lens levels, models, usage and lineage. The review registry installs summary, decision and verification extensions. The sweep covers lens, decision, adjudication and verification tasks. Replacement triage detaches pending verification even when lenses finished.

VerdictDocument stays at version 5. Migration reads all older shapes, preserving verification, provenance and decisions. Head-only version 1 keys stay head-only. Added SQLite reopen regressions for every version, a triage retirement regression and a ledger rendering regression for run details beside verification outcomes. Updated CLI expectations for verifier warnings and credential unlocking. Kept both sides’ crash scenarios and all skills’ walkthrough and verification retry rules.

Validation uses fake models only. The 19 affected files pass 610 tests. The pre-commit gate passes 58 files with 1,470 tests passed and 50 skipped. No test timed out. The merge report records affected tests and full-gate summaries under tmp/merge80-report.md.
