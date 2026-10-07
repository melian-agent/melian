# Prove Enola policy and diagnostic boundaries

[Pull request #89](https://github.com/melian-agent/melian/pull/89) now tests deterministic policy ordering, primary and fallback configuration, configuration without constraints, YAML warnings and exact typed SARIF diagnostics.

An unchanged revision returns false. Each policy read retains the 256 KiB limit, including head comparison against an identical oversized factory input. All 29 rows have failing mutations. The restored suite passes 15 tests.

A comparator result must be inverted to prove its ordering branch. Returning zero for a greater key can preserve the order under a stable sort, so that condition inversion alone supplied no proof.
