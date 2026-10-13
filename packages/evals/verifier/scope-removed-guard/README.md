# scope-removed-guard

Source: [the decision](../../../../docs/decisions/2026-10-12-verifier-lowers-severity-and-sets-scope.md), Goldens, scope: a removed guard.

The base guards the read with `fields.length < 2`, and the head weakens the guard to `< 1`. The verifier points at the untouched read and proposes `pre-existing`. A hunk deletes code inside the function that holds the failure, so rule (d) refuses.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
