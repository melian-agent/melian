# scope-dead-code-reached

Source: [the decision](../../../../docs/decisions/2026-10-12-verifier-lowers-severity-and-sets-scope.md), Goldens, scope: a base location in dead code that the head makes reachable.

At the base nothing calls `parseRecord`. The head makes `run` call it. The failing lines exist at the base, so the verifier proposes `pre-existing`, and it names the route that reaches them. That route is the changed line, inside a hunk, so rule (c) refuses.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
