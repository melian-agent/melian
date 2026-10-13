# lowering-co-report-keeps-severity

Source: [the decision](../../../../docs/decisions/2026-10-12-verifier-lowers-severity-and-sets-scope.md), Goldens, lowering: a deterministic co-report that keeps its severity.

A deterministic check reports the same line beside the lens's P1. The verifier confirms the lens claim and asks for P2. A defect a deterministic check co-reported is never lowered, so the merged finding stays a blocking P1.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
