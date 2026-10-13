# The re-implemented authority rule, for [pull request #114](https://github.com/melian-agent/melian/pull/114)

Milestone 2 step 19, "The design lens flags a re-implemented authority". Commit 8c0b0d23 adds the rule `reimplements-an-authority` to the `design` lens, with a `design` hand-off on `correctness` and on `conventions`, [the decision](../decisions/2026-10-13-reimplemented-authority-rule.md) that names the baseline and the boundary, and the section in the design. Commit 312b9f60 adds three goldens: a note's YAML header split at each colon beside a `yaml` dependency, a `preinstall` Node check that cannot ask `semver` and says why, and a delay format no dependency covers. Commit cbaed255 marks the step in progress in the plan.

The verifier's design catalogue reads the built-in lens, so it needed no change. The versions of `design`, `correctness`, and `conventions` changed, and `packages/core/test/lens.test.ts` pins the new ones.

The change adds lens text and fixtures, and no code guard. Twelve mutations each removed one sentence or hand-off from a lens, and each failed a named test in `packages/core/test/lens.test.ts`: the design lens's load test for the rule and its body, and the hand-off test for the three hand-offs. Four mutations of the golden fixtures failed `packages/evals/test/design-fixtures.test.ts`. The whole gate passed.

No live eval ran, since the lane held no credentials. The step is done when three live passes over the `design`, `correctness`, and `conventions` goldens are recorded under `packages/evals/runs/`.
