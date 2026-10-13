# scope-new-caller

Source: [the decision](../../../../docs/decisions/2026-10-12-verifier-lowers-severity-and-sets-scope.md), Goldens, scope: a new caller beside an older unvalidated one.

The base already calls `parseRecord` from `run` without validating, and the head adds a second caller in `other.ts`. The lens blames the new call, so the finding is `affected`. The verifier names the older caller as the trigger and proposes `pre-existing`. A hunk adds a line that names the failing symbol, so the cross-check under rule (d) refuses, as rule (a) does for the evidence on a changed line.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
