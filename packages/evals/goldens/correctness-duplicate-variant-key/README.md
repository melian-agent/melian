# correctness-duplicate-variant-key

Seeded from finding C3 of the [comparison record](../../comparisons/2026-10-05-pr-62.md) for [pull request #62](https://github.com/melian-agent/melian/pull/62): bandsOf keyed bands by a lens name shared by folder variants under different policy.

The golden expects `correctness`'s `wrong-result`. The base handles the declared input; the changed line in the head computes the wrong result. The trees deliberately contain this defect. The caller supplies two folder variants with the same lens name and distinct selections, so the overwrite needs no invalid input.
