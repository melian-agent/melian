# surfacing-silent-p0-listed

Source: [the decision](../../../../docs/decisions/2026-10-13-re-scope-held-for-the-compiler.md), Goldens, surfacing: a pre-existing P0 that the table maps to `silent` is listed at `advisory`, and the verdict and exit code do not change.

The repository's `melian.yaml` resolves P0 `silent`. A pre-existing P0 is a member, and a member never resolves below `advisory`: the caps apply first, then that floor. The finding is listed, and the review reads as it did before the heading existed: `passed`, not blocking, with the exit code a silent finding gives.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
