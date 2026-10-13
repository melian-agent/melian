# scope-moved-with-edit

Source: [the decision](../../../../docs/decisions/2026-10-12-verifier-lowers-severity-and-sets-scope.md), Goldens, scope: a moved function with a one-character edit.

The head renames `parse.ts` to `reader.ts` and changes `fields[1]` to `fields[2]`. Git reports a rename, so Melian finds the base file by its old path and compares the failing line byte for byte. One character differs, and rule (b) refuses.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
