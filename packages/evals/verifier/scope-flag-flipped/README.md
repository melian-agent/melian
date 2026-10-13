# scope-flag-flipped

Source: [the decision](../../../../docs/decisions/2026-10-12-verifier-lowers-severity-and-sets-scope.md), Goldens, scope: a flag flipped in another file, with the trigger named.

At the base `strict` is true, so `start` never reaches `run`. The head flips it in `config.ts`. The verifier names the flag's reader as the trigger and the flag as part of the path, as it must. The flag's line is inside a hunk, so rule (c) refuses, and the cross-check under (d) finds the hunk that changes a name the trigger reads.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
