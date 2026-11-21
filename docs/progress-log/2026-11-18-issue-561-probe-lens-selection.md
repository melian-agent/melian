# Issue 561: a probe lens must review a changed file

[Issue #561](https://github.com/melian-agent/melian/issues/561).

Codex's adversarial review of [pull request #550](https://github.com/melian-agent/melian/pull/550) at 28d05347 found that `MELIAN_EVAL_PROBE_LENSES` could name a lens the review never runs. `ProbingCombination.routed` checked that the policy loads the lens, that core lets it probe and that the tier runs it, but not that `Lens.select` picks it. A `melian.yaml` that switches the lens off, or narrows its paths away from every changed file, left a measurement scoring a prober that never ran. The coordinator directed, on 2026-11-18, that the check go in this issue, where the route is given the changed files.

`routed` now takes the changed files, as `ProbingRoute` declares, and refuses a named lens that `Lens.select` drops for them, with "which reviews none of the changed files".

The test came first. In `packages/evals/test/probing.test.ts`, "refuses a lens the review's configuration switches off, or narrows away from every changed file" sets `correctness` to `enabled: false` and then to `paths: ["docs/**"]`, against a change to `src/a.ts`. At 405ab393 it failed with `{"enabled":false}: expected [Function] to throw an error`. With the fix, all 74 probing tests pass. The test also routes a narrowing that keeps `src/a.ts`, so a check that refused every narrowed lens would fail it.
