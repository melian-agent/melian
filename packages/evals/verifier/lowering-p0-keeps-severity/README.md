# lowering-p0-keeps-severity

Source: [the decision](../../../../docs/decisions/2026-10-13-re-scope-held-for-the-compiler.md), Goldens, lowering: a P0 that keeps its severity.

The lens reports the same read at P0. The verifier confirms it and asks for P1 with evidence. A P0 is never lowered, so Melian refuses, records the verdict, and the finding still blocks at P0.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
