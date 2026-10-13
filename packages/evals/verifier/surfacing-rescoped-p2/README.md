# surfacing-rescoped-p2

Source: [the decision](../../../../docs/decisions/2026-10-12-verifier-lowers-severity-and-sets-scope.md), Goldens, surfacing: a re-scoped P2 is listed under "Pre-existing, important" with the reason and the original scope.

A P2 the verifier re-scoped is a member of "Pre-existing, important". The terminal lists it under that heading with the verifier's reason and the scope location gave it, and the JSON lists it under `preExistingImportant`.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
