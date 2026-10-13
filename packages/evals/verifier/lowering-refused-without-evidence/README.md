# lowering-refused-without-evidence

Source: [the decision](../../../../docs/decisions/2026-10-13-re-scope-held-for-the-compiler.md), Goldens, lowering: a lowering refused for want of evidence.

The verifier confirms a P2 and asks for P3, and cites no code. A lowering needs evidence locations as a refutation does. Melian refuses it, and the lens's P2 stands.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
