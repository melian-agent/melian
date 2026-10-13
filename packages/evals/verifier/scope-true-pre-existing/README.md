# scope-true-pre-existing

Source: [the decision](../../../../docs/decisions/2026-10-12-verifier-lowers-severity-and-sets-scope.md), Goldens, scope: a true pre-existing case, which re-scopes and is capped.

The lens reports a P1 over the whole of `parseRecord` because the change edited its comment. The failing line and its callers are untouched, the base holds the same bytes, and the hunk deletes only a comment. All four rules hold, so the finding becomes `pre-existing` and is capped at advisory: it no longer blocks.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
