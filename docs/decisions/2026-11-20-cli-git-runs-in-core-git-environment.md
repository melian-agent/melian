# The CLI's git runs in core's git environment

Amends: [the decision that Melian's git reads no replacement objects](2026-11-17-git-reads-no-replacement-objects.md), what the CLI's helper passes through
Amends: [the decision that Melian's git pins `core.useReplaceRefs` off](2026-11-17-git-pins-core-use-replace-refs.md), the clause that the CLI's helper leaves `GIT_CONFIG_COUNT` and its entries as the caller set them

Status: for [issue #539](https://github.com/melian-agent/melian/issues/539). The maintainer ruled on 2026-11-18 to build it, as the coordinator relayed on 2026-11-20.

## Problem

Core's `git` removes the variables `git rev-parse --local-env-vars` names before it runs git. The CLI's `git` in `packages/cli/src/repository.ts` kept them, so a caller's shell could point the CLI's reads at another repository or another history.

Example: a hook runs `melian review "#12"` with `GIT_DIR` set to its own repository. The CLI fetches the pull request's refs into the hook's repository and reads its commits from there, while core reads the clone it was given. `GIT_GRAFT_FILE` and `GIT_SHALLOW_FILE` change the parents the merge-group check reads, and `GIT_ALTERNATE_OBJECT_DIRECTORIES` lends objects the clone does not hold.

## Choice

Core exports `gitEnvironment`, the environment its own `git` runs with, and the CLI's `git` runs with it. The CLI now drops what core drops: every repository-local variable, `GIT_CONFIG_COUNT` with its entries and `GIT_CONFIG_PARAMETERS` among them, and turns optional locks off.

The cost: a git setting the caller passes through `GIT_CONFIG_COUNT` or `GIT_CONFIG_PARAMETERS`, such as a URL rewrite, no longer reaches the CLI's fetches. Settings in the user's global and system configuration still do, as they do for core. A cloud session sets its URL rewrite through `GIT_CONFIG_COUNT`, and its `origin` already names the URL the rewrite produces, so its fetches still work. The `melian round` workflow sets none.

## Proof

`packages/cli/test/repository.test.ts` asks git for its repository-local variables and runs one test per name: it sets the variable, has the CLI run a repository alias that prints git's environment, and checks the caller's value is not there. Thirteen of the fifteen failed before the change, for that reason or because git refused the value. `GIT_NO_REPLACE_OBJECTS` and `GIT_PREFIX` passed already, since the helper and git overwrite them. A second test points `GIT_DIR` at another repository and reads `melian.yaml` from the one the CLI was given. All pass after the change.
