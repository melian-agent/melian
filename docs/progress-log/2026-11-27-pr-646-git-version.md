# Pull request 646 keys a probing run by git's version

Builder agent, for [pull request #646](https://github.com/melian-agent/melian/pull/646) and [issue #644](https://github.com/melian-agent/melian/issues/644).

The Melian round at 6edce45ac found that the probing host keyed the kind of git a probe runs but not its version. Node's version and the sandbox's release were already in the key. So after an Xcode or Command Line Tools update, a run probed under one Apple Git release was reused under another. That is an input missing from the key, the first of [the identity guideline's](../guidelines/identity.md) four failures, and the second round in a row to find one in this key.

The coordinator withdrew its earlier "no version" constraint on 2026-11-27 and set one rule for the key. The probing host holds the kind and the version of each program a probe can run that the host supplies, Node, the sandbox and git, and nothing else of the host. Host files such as the system git configuration stay out for a written reason. That is a coordinator's answer, not a maintainer ruling. The decision's Keys section and the identity guideline's row now state the rule. A third missing input that the rule does not settle goes to the maintainer, not to another fix.

The lookup now asks the chosen git `--version`, with the same cleaned environment as its other questions, and keeps the whole trimmed answer. An answer that is empty, longer than 200 characters, or holds a line break or another control character leaves git unavailable. `probingHost` keys it as `gitVersion`, absent on Linux and where git is unavailable, so earlier keys hold.

The test "probes again when only the version of the host's git changes", in `packages/pipeline/test/probing-level.test.ts`, was written first. On the old code it failed at the step that changes only the version, with `expected +0 to be 2`: the level reused the run. After the fix it passes. `probe-git.test.ts` tests the bound at 200 characters and one past it, plus an empty answer, two lines, a control character and a failed question. `probing.test.ts` refuses a probe planned under another git release.

[The inventory](2026-11-27-pr-646-git-version-mutants.json) of 922ca430b lists 30 generated mutants in `probe-git.ts` and `probing.ts`, and each was run by hand. Each named test was collected alone, passed unmutated, and failed mutated. Several of the mutants sit on lines the fix only reformatted, such as the two grant returns, which now carry the version.
