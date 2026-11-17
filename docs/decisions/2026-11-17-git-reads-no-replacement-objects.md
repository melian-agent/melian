# Melian's git reads no replacement objects

Status: for [pull request #525](https://github.com/melian-agent/melian/pull/525), on [issue #502](https://github.com/melian-agent/melian/issues/502). The maintainer ruled on 2026-11-17, in the coordinator's session, for this option, recorded on #525.

## Problem

Melian names a commit by its full object ID and trusts that the ID always shows the same tree. #525 rests a rule on it: a dismissal on a review whose policy came from a commit decides again under the current fingerprint computation, since a commit cannot change. Git breaks that promise by default. A ref under `refs/replace/` puts another object behind an ID, and every read of the ID shows the replacement.

Example: a review reads `melian.yaml` from commit `C`, which makes P2 blocking. Anyone who can write refs in the reviewer's clone runs `git replace C L`, where `L` holds a `melian.yaml` that makes P2 advisory. The next dismissal reads `C`, gets `L`'s tree, and decides under the looser policy. Core's git environment removed `GIT_NO_REPLACE_OBJECTS` with the other repository-local variables, so nothing turned replacement off.

## Choice

Every git call Melian makes that reads objects by ID runs with `GIT_NO_REPLACE_OBJECTS=1`. That covers core's `git` in `packages/core/src/git.ts`, the CLI's `git` in `packages/cli/src/repository.ts`, and the static checks' `git` in `packages/pipeline/src/static.ts`, which checks the commit out for Biome, tsc, Enola and the mutation check. Git disables replacement whenever the variable is present, whatever its value, and the variable outranks `core.useReplaceRefs` in `.git/config` and in `GIT_CONFIG_PARAMETERS`. Two calls are left alone. The probe's `git` in `packages/pipeline/src/probe.ts` runs in a temporary repository that borrows the checkout's objects through alternates, and alternates carry objects, not refs, so no replacement ref is there to apply. The static check's `ls-files` in `packages/pipeline/src/static.ts` reads the index, which replacement does not touch. `CacheLocation.open` in `packages/pipeline/src/tool-provisioning.ts` asks only for the common directory. `packages/pipeline/src/store-prune.ts` lists worktrees and refs and asks which stored heads exist, and decides nothing by a tree.

`packages/core/test/replace-objects.test.ts`, `packages/cli/test/repository.test.ts` and a test in `packages/pipeline/test/static.test.ts` build a clone with `refs/replace/<commit>` pointing at a looser `melian.yaml`. They assert that Melian reads the original.

## The other ways a clone can change what an ID reads

A review briefed as unit tests checked each one on git 2.43. Each case built a clone, recorded a full ID and its policy, changed the clone, and read again. In no case did `loadConfig` read a different `melian.yaml` for the same full ID. None of these is fixed here; each needs its own ruling.

- **A replacement ref under another base, through `GIT_REPLACE_REF_BASE`.** Core removes the variable. In the CLI's helper, `GIT_NO_REPLACE_OBJECTS` outranks it. Either way Melian reads the original.
- **A graft in `.git/info/grafts`.** Git 2.43 still honours grafts, with a deprecation hint, and `GIT_NO_REPLACE_OBJECTS` does not turn them off. A graft changes a commit's parents, not its tree. So the policy read for an ID stays the same, while `rev-list`, `log` and `merge-base` report another history.
- **A shallow file, `.git/shallow`.** It cuts history at the commits it names. The tree read for an ID stays the same; `rev-list` and `merge-base` change.
- **Alternates, `.git/objects/info/alternates`.** An alternate lends objects. Removing one makes a read fail with an error, not a different policy. A real object with other content cannot carry the same ID short of a hash collision. A file stored under the wrong ID can: `loadConfig` refuses it with `hash mismatch`, because the revision source runs `rev-parse --verify <id>^{commit}` first. A bare `git show <id>:path` skips that check and reads the mislabelled content. The same holds for a mislabelled object in the clone's own store.
- **A forged commit-graph file.** `log --format=%T` and `rev-list --objects` can report another tree for the ID. `loadConfig` reads trees through `ls-tree` and `cat-file`, which do not use the commit-graph, so its policy is unchanged.
- **The caller's `GIT_GRAFT_FILE`, `GIT_SHALLOW_FILE` and `GIT_ALTERNATE_OBJECT_DIRECTORIES`.** Core removes them. The CLI's helper passes the caller's environment through, so they reach its history reads, though not the trees it reads.

Builder agent: two follow-ups the review raised, for a ruling. The CLI's helper keeps the repository-local variables core removes; routing it through core's environment would close that. And a read of `<id>:path` with no hash check can return a mislabelled object; every policy read today goes through the revision source, which checks.
