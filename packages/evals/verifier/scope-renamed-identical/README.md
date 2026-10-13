# scope-renamed-identical

Source: [the decision](../../../../docs/decisions/2026-10-12-verifier-lowers-severity-and-sets-scope.md), Goldens, scope: a renamed file with identical content, which may re-scope.

The head renames `limits.ts` to `bounds.ts` and edits nothing. The lens cites the renamed file as a cause, which makes the finding `affected`. Git reports the rename with identical content, so no line of it is the change's: rule (a) lets the evidence stand, and the other three rules hold. The finding becomes `pre-existing`, and a re-scoped P1 is listed under "Pre-existing, important".

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
