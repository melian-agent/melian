# lowering-narrow-trigger

Source: [the decision](../../../../docs/decisions/2026-10-12-verifier-lowers-severity-and-sets-scope.md), Goldens, lowering: a narrow trigger that earns one step.

The lens reports a P2 on the new read of `fields[1]`. The verifier confirms it and finds that `run`, the only caller, returns early for a record without a comma. It lowers the claim to P3 with that line as evidence, and Melian accepts: one step, on a confirmed verdict, with evidence it read back. The finding resolves at P3 and shows the P2 and the reason.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
