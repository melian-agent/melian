# Run details: merged check-record assertions

[Fix pass 4 on issue #213](https://github.com/melian-agent/melian/issues/213#issuecomment-6432820397), for [pull request #221](https://github.com/melian-agent/melian/pull/221).

All four reported failures reproduce at `12c1c825`.
Each exact assertion lacks the check record's deliberately added `version` field.
Commit `e0befe8e` added that field to distinguish lens variants, whose versions include their folders.
The failed pending-adjudication assertion also compares an exact object inside `arrayContaining`.
Its status, reason and caveat already match.

The assertions now require each loaded lens's exact version.
The light-triage caveat still considers every selected lens, including refused and skipped lenses.
The tool-budget replay and adjudication-supersession assertions keep their existing outcomes.
No production code, design decision or plan status changes.

Validation:

- Before: `npx vitest --run packages/pipeline/test/triage.test.ts packages/pipeline/test/review-crash.test.ts` exited 1: four failed, 115 passed.
- After: those files plus `packages/pipeline/test/run-check-outcomes.test.ts`, `packages/pipeline/test/stage-telemetry.test.ts` and `packages/cli/test/publish-run.test.ts` passed all 148 tests across five files.
- Biome and `git diff --check` passed. The branch diff was reviewed before commit.
- The sandbox ran targeted files only, as instructed. The whole pipeline and CLI suites and `npm run check` remain for the host; no full-gate pass is claimed.

The [committed inventory](2026-10-27-quiet-run-details-fix4-mutants.json) records zero production mutants and zero omissions for this test-only pass.
Three supplementary mutations ran by hand against production code, then were restored.
Removing or replacing a completed lens's version each failed the three updated completed-lens assertions.
Removing a refused lens's version failed the refused-lens assertion.
The inventory includes exact coordinates, replacements, the scratch runner, failing outputs and the final passing run.
