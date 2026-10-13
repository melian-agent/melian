# surfacing-rescoped-p3

Source: [the decision](../../../../docs/decisions/2026-10-12-verifier-lowers-severity-and-sets-scope.md), Goldens, surfacing: a re-scoped P3 is an ordinary pre-existing finding.

The same re-scope of a P3 holds, and the finding becomes `pre-existing`. A re-scoped finding is a member only at P2 or higher, so this one is listed as an ordinary advisory finding.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
