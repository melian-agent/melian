# conflict-lowering-both-orders

Source: [the decision](../../../../docs/decisions/2026-10-13-re-scope-held-for-the-compiler.md), Goldens, conflict: duplicate calls for one claim in both orders, one lowering and one not.

The verifier reports one claim twice with the same verdict: once lowering it to P3, once not. On equal verdicts the record keeps the higher severity, so the finding is unlowered. The golden runs both orders and expects the same.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
