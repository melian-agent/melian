# conflict-scope-both-orders

Source: [the decision](../../../../docs/decisions/2026-10-12-verifier-lowers-severity-and-sets-scope.md), Goldens, conflict: two scope answers that conflict.

The verifier reports one claim twice with the same verdict: once with a re-scope every rule accepts, once without. On equal verdicts the record keeps the stronger scope, so the finding stays `introduced` and blocks. The golden runs both orders and expects the same.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
