# Step 29 pass 5: reuse the confirmed outcome

[Pull request #144](https://github.com/melian-agent/melian/pull/144) closes the repeated class behind the review of record’s F1.
A refutation made a pre-existing trust P1 count when the confirmed claim was only a display lift.
The same happened after lowering, or beside a pre-existing merged report.

The protected minimum now calls the confirmed claim’s existing decision path.
It retains that outcome’s resolution and lift, then caps the resolution at acknowledgement.
Standing reports still supply stricter requirements, and a counted outcome wins a tie with a lift.
The lift stays in transient decisions and the verdict’s existing importance list.
Stored shapes and the implementation plan’s status stay unchanged.

The two silent-policy regressions failed on `dcbef598` before the fix.
The review’s grid also fails there and passes with the fix: 2,304 single cases and 6,144 merged cases.
The merged grid runs both report orders.
It checks the protected outcome against the confirmed claim, while retaining stricter standing requirements.
That exception preserves the existing non-monotone-table regression.

The pass report and exact mutation inventory are `tmp/step29-pass5-report.md` and `tmp/step29-mutation-inventory.md`.
The coordinator must run the host mutation check and the next full model review.
This pass makes no live model calls.

The first gate found six exact-object failures because optional transient fields were emitted when absent.
The fix omits those fields from ordinary decisions; existing API-shape tests prove the contract.

The whole-gate rerun exited 1 in 412.15 seconds: 4,651 passed, 53 skipped and four known sandbox process failures.
Lint, types, dependency checks and the audit threshold passed. No changed test or timeout failed.
The report names every failure and the three `ps`-gated skips. The coordinator must rerun the whole gate on the host.
