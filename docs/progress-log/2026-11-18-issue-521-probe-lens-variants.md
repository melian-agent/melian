# Issue 521: every variant of a probe lens must be able to probe

[Issue #521](https://github.com/melian-agent/melian/issues/521), [pull request #550](https://github.com/melian-agent/melian/pull/550).

The Actions round at c6d20701, [run 44215339185](https://github.com/melian-agent/melian/actions/runs/44215339185), raised a P2 acknowledge finding from the design lens. `Lens.load` returns one lens of a name for each folder that defines it. `ProbingCombination.routed` asked only the first of them whether it may probe, then gave every one of them a probe. So a repository lens that takes `trust-boundary`'s name without extending it would probe under the built-in lens's wording, which core refuses at load. It now asks every variant, and refuses the name if any refuses.

The test came first. In `packages/evals/test/probing.test.ts`, "refuses a named lens when any variant of it cannot probe, not only the first" loads the built-in `trust-boundary` and, after it, a `trust-boundary` that shadows the built-in. At c6d20701 it failed with `expected [Function] to throw an error`. With the fix, all 72 probing tests pass.

The fix's 13 mutants were enumerated over `c6d20701...cb18ff78`, and each was run against its named test alone. All 13 were killed; [the inventory](2026-11-18-issue-521-probe-lens-variants-mutants.json) records each.
