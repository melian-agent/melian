# Step 28 pass 5: print attestations after a refusal

[Pull request #142](https://github.com/melian-agent/melian/pull/142), review-of-record F2.

A pending round posted its dismissal, then the current round was refused.
The CLI printed no attestation for the posted round.
The probe failed first with empty output where the earlier finding ID should appear.
A failed resumed task followed by a fresh task reproduced the same loss.

Failed publication tasks now keep their posted rounds’ attestations in Pi’s existing optional error-detail field.
`PublishError` carries those snapshots to the CLI, which prints them before reporting the failure.
The task’s input, checkpoint and result schemas stay unchanged.
Older failures without that detail contribute no snapshots.

Validation: three regression cases failed before the fix; 19 focused tests passed afterwards, as did type checking.
Nine hand mutations failed the refusal, resumed-task, legacy-detail, error-output and empty-default tests.
The inventory and failing output are under `tmp/step28-pass5-*`; the coordinator owns the host mutation check.
The whole gate follows this pass. The implementation plan stays unchanged.
