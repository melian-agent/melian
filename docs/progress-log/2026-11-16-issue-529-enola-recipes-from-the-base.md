# Enola recipes come from the base

[Issue #529](https://github.com/melian-agent/melian/issues/529): a head could switch off an Enola check by adding `enola/recipes/<name>.yaml` under the name of a recipe Enola ships. Enola reads that file in place of its own recipe, and neither Melian's policy pattern nor the runner's removals named `enola/recipes/`. So a base that binds the shipped `layered` recipe lost `lay/infrastructure-does-not-drive-the-domain` to a head's copy without that rule, and no policy notice was raised.

Core now lists every path Enola reads policy from, in `enolaPolicyFiles` and `enolaPolicyDirectories`. The policy pattern is built from that list, and so is the runner's removal of the head's copies. [The decision](../decisions/2026-11-16-enola-policy-paths-come-from-enola.md) says how the list was established, by asking the pinned Enola 0.4.40, and why Markdown stays out.

Failing tests first, at e5648b2e with the tests alone: four failed for the reported reason. `isPolicyFile` refused `enola/recipes/layered.yaml`; `EnolaPolicy.load` left the recipe out; `differs` missed a head that added one; and the fake Enola exited 9 because the head's recipes reached it. All passed after the fix.

A new test covers the removal order: a head whose `.enola` links to an outside directory leaves that directory's `suppressions.yaml` alone. Moving `.enola` last in the removal list deletes it, and the test fails.

Mutants: [the inventory](2026-11-16-issue-529-enola-recipes-mutants.json) lists all 25 of the range's mutants. Seven are generated in the two files that guard trust, `packages/core/src/enola-paths.ts` and `packages/pipeline/src/enola-static.ts`; the rest are string literals the configuration ignores. Each of the seven was run by hand against its named test alone, which passed unmutated and failed mutated, at 6f74cb51: 7 of 7 killed, the five in `enola-paths.ts` by core's test that reads every policy path from the base, and the two in `enola-static.ts` by the pipeline's base-policy test. The full gate passed at that head.
