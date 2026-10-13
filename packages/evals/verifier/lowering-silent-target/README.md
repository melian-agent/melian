# lowering-silent-target

Source: [the decision](../../../../docs/decisions/2026-10-13-re-scope-held-for-the-compiler.md), Goldens, lowering: a P2 that is not lowered where the folder's table resolves P3 `silent`.

The repository's `melian.yaml` resolves P3 `silent`. A lowering from P2 to P3 there would silence a confirmed finding, so Melian refuses it and the finding stays a P2 to acknowledge.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
