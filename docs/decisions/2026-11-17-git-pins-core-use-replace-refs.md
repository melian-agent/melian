# Melian's git pins `core.useReplaceRefs` off as well

Amends: [the decision that Melian's git reads no replacement objects](2026-11-17-git-reads-no-replacement-objects.md), the claim that `GIT_NO_REPLACE_OBJECTS` outranks `core.useReplaceRefs` in `.git/config`

Status: for [pull request #537](https://github.com/melian-agent/melian/pull/537)'s review, on [issue #502](https://github.com/melian-agent/melian/issues/502). Builder agent: the coordinator directed this fix on 2026-11-17 and ruled out raising the git floor without a ruling; the fix is mine.

## Problem

The decision says `GIT_NO_REPLACE_OBJECTS` outranks `core.useReplaceRefs` in `.git/config`. That holds from git 2.42. On git 2.40 and 2.41, which Melian accepts, git reads the setting after the variable, so a repository that sets `core.useReplaceRefs=true` turns replacement back on.

Example: on git 2.41, a clone holds `refs/replace/C` pointing at `L`, whose `melian.yaml` makes P2 advisory, and its `.git/config` sets `core.useReplaceRefs=true`. Melian's read of `C` runs with the variable set and still gets `L`'s tree.

## Choice

Each of the four places that set the variable also sets `core.useReplaceRefs=false` on git's command line, which outranks every configuration file on every version.

- Core's `gitEnvironment` and the CLI's `git` call core's new `withoutReplacements`. It adds the setting through `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`, after any settings the caller's count already holds, so the CLI keeps a caller's own. Core removes the caller's count with the other repository-local variables first, so its pin is the only one.
- Store prune's `git` removes every `GIT_` variable, then calls `withoutReplacements`.
- The static checks' shell `git` unsets the count and already passes `-c` options, so it passes `-c core.useReplaceRefs=false`.

The floor stays at git 2.40. Raising it would need a ruling.

## Proof

A test in each of `packages/core/test/replace-objects.test.ts`, `packages/cli/test/repository.test.ts`, `packages/pipeline/test/static.test.ts` and `packages/pipeline/test/store-prune.test.ts` puts a `git` shim first on the path. The shim records what `git config --get core.useReplaceRefs` reads under the options and environment Melian passed, then runs the real git. With the repository's configuration set to `true`, each read `true` before the fix and `false` after it. That shows the pin reaches git, on any version.

It does not show git 2.40 or 2.41 obeying it. This container's git is 2.43 and CI's runners are newer, so neither shows the gap. Building or unpacking git 2.40 here was refused by the session's permission checks, so no run on 2.40 is recorded. That command-line configuration outranks repository configuration on 2.40 is git's documented order, not a run of ours.
