# scope-edited-copy

Source: [the decision](../../../../docs/decisions/2026-10-12-verifier-lowers-severity-and-sets-scope.md), Goldens, scope: an edited copy of a buggy function.

The head adds `rows.ts`, a copy of `parseRecord` edited to split on semicolons. The finding sits in the copy. The verifier says the same lines fail at the base. Git reports the file as added, so it has no base file under the rename map, and rule (b) refuses.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
