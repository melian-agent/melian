# Step 28 pass 6: retain attestations when the target moves

[Pull request #142](https://github.com/melian-agent/melian/pull/142).

The final cold round found that a target change after GitHub accepted a review lost its dismissal attestations.
The two corrected regressions failed first: expected the posted round’s snapshot, received an empty array.
They cover a fresh task and an interrupted task resumed by the same invocation.
The initial test draft used the wrong finding construction for dismissal metadata; the corrected baseline reproduced only the reported defect.

Publish task version 5 returns the accumulated snapshots on a stale-target exit.
PublishError carries those snapshots and those of resumed tasks.
Its message says publication stopped, since a review may already have posted.
A fixture recorded by version 4’s own code at 3207a611 proves SQLite reopen and timing preservation.
Versions 1 and 2 keep legacy timing; versions 3 and 4 retain their starts.

The publication controls also cover a ledger refusal after a post, a refused resumed task, an actual abort, a superseded current task and a successful resumed task with different dismissal membership.
Hand mutations cover the exact line-1301 array replacement and its fallback array, both stale-target contributions, resumed completed outcomes and both timing bounds.
Every replacement and failing test is appended to tmp/step28-phase2-mutations.md.
Before/after logs and the final gate result are recorded in tmp/step28-pass6-report.md.
The implementation plan stays unchanged for this fix pass.
