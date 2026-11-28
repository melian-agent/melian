# conflict-lowering-both-orders

Source: [the decision](../../../../docs/decisions/2026-10-13-re-scope-held-for-the-compiler.md), Goldens, conflict: duplicate calls for one claim in both orders, one lowering and one not, as [the first-report decision](../../../../docs/decisions/2026-11-28-a-claims-first-report-stands.md) amends it.

The verifier reports one claim twice: once confirmed and lowered to P3, once plausible and not lowered. Confirmed first, the weaker plausible report is refused, so the lowering stands. Plausible first, the stronger confirmed report replaces it whole, its lowering included. The golden runs both orders and expects the finding lowered to P3 in each.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
