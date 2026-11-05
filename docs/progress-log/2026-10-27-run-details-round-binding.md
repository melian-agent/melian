# Run details stay with the review round

Fix pass 3 on [issue #213](https://github.com/melian-agent/melian/issues/213#issuecomment-6431755745), for [pull request #221](https://github.com/melian-agent/melian/pull/221).

The review binds its spans to its adjudication's round. The CLI captures run details in a new document family keyed by that round ID. Capture checks the current round, verdict, adjudication, check parent and exact preparation record. Publication requests the validated round's snapshot, validates again, and checks the run ID in the durable task. It drops another round's stored table. A round without a snapshot uses the existing fallback. Detached stage reads keep their earlier shape.

The ruling amends the [run details decision](../decisions/2026-10-25-run-details-from-telemetry.md) through the [round binding decision](../decisions/2026-10-27-run-details-bound-to-round.md). Old document and task versions remain unchanged. The new version-1 snapshot family has a two-reopen SQLite test.

All six defect regressions were run against the starting head, `5ed29934`, with source restored afterwards. Each failed for its reported reason:

- Failed rerun: the decided round's ledger unexpectedly contained `check guardrails` from the rerun.
- Advanced round: a captured earlier run still rendered `Run details: 142 s` on the new round.
- Refused folder variant: the run rendered `failed`, instead of `ran, failed`.
- Folder fallback: the run rendered `failed, failed`, instead of `ran, failed`.
- Reconstructed verifier, `ran`: `usageIncomplete: true` was missing.
- Reconstructed verifier, `ended`: `usageIncomplete: true` was missing.

The restored implementation passes all 488 tests in 15 targeted files. These cover core run rendering and route judgement; pipeline review, triage, plans, capture, publication, telemetry, spans and reopen cases; and CLI publication and telemetry. `npx tsc --noEmit` passes. The [earlier inventory](2026-10-27-run-details-verifier-lens-mutants.json) records the first two fixes. A further inventory records the final source head's hand mutation runs.

The full pipeline and CLI suites and `npm run check` were not run in the sandbox. The host runs them. The implementation plan stays unchanged for this fix pass.
