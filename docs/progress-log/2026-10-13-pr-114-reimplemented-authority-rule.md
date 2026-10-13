# The re-implemented authority rule, for [pull request #114](https://github.com/melian-agent/melian/pull/114)

Milestone 2 step 19, "The design lens flags a re-implemented authority". Commit 8c0b0d23 adds the rule `reimplements-an-authority` to the `design` lens. It also adds [the decision](../decisions/2026-10-13-reimplemented-authority-rule.md) that names the baseline and the boundary, and the section in the design. Commit 312b9f60 adds three goldens: a note's YAML header split at each colon beside a `yaml` dependency, a `preinstall` Node check that cannot ask `semver` and says why, and a delay format no dependency covers. Commit cbaed255 marks the step in progress in the plan.

The verifier's design catalogue reads the built-in lens, so it needed no change. The versions of `design` and `correctness` changed, and `packages/core/test/lens.test.ts` pins the new ones.

Codex's adversarial review found four things, and each has its own commit. The stated-gap golden passed a prerelease Node that `semver` refuses, so its range check now reads only a released version and has tests at the bound. `correctness` and `design` both claimed a guessing fallback under a stated gap; `design` now owns it alone. `conventions` handed every re-implementation to `design`, which left a standard unreported under an accepted gap; `design` now hands that case to `conventions`, which is unchanged. A stated gap whose reason no code supports no longer excuses the finding, and a fourth golden, `design-reimplements-an-authority-unsupported-gap`, holds that case.

The change adds lens text and fixtures, and no code guard. Each sentence of the rule and each hand-off was removed in turn, and each removal failed a named test in `packages/core/test/lens.test.ts`. Mutations of the golden fixtures failed `packages/evals/test/design-fixtures.test.ts`.

No live eval ran, since the lane held no credentials. The step is done when three live passes over the `design` and `correctness` goldens are recorded under `packages/evals/runs/`.
