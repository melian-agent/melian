# scope-co-report-keeps-cause

Source: [the decision](../../../../docs/decisions/2026-10-12-verifier-lowers-severity-and-sets-scope.md), Goldens, scope: a deterministic co-report, which keeps its cause beside a re-scoped lens claim.

A deterministic check reports the same lines as `introduced`. The verifier's re-scope of the lens claim holds and is stored on that claim. The merge keeps the strongest cause any member gave, so the defect stays `introduced` and keeps its resolution.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
