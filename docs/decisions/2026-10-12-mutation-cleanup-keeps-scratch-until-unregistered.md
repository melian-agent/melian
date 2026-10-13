# Confined cleanup drops its registration last

Supersedes: none.

Problem: a confined teardown has three things to remove: the trees head code wrote in, the scratch directory around them, and each tree's registration in the reviewer's repository. Three earlier orders each failed.

- Deleting scratch before unlocking left a locked registration when the reviewer crashed between the two, and the retry failed on the absent scratch.
- Unlocking first erased the lock, which is the only record that head code wrote the tree. A crash after the unlock left a tree the next run removed on the host with `git worktree remove --force --force`.
- Pruning, with `git worktree prune --expire=now`, dropped every stale registration in the repository, the user's own among them. [The pipeline guideline](../guidelines/pipeline.md#static-tools-run-in-the-execution-environment) already forbade it for that reason.

Example: a user deletes a worktree's directory by hand and means to run `git worktree repair` after restoring it from a backup. A review runs meanwhile, and its teardown prunes. The user's branch is no longer checked out anywhere git knows of.

Choice: remove each tree under retained confinement, then empty and remove scratch the same way, then drop the registrations. The teardown never unlocks, never prunes, and never asks host git to remove a path. It deletes exactly one kind of thing on the host: an entry under the repository's `worktrees` directory whose `gitdir` file names `<scratch>/tree/.git` or `<scratch>/base/tree/.git`, read and compared before the removal. A relative `gitdir` resolves against its entry. Head code cannot write that entry, since the sandbox grants nothing in the repository's git directory.

The registration is the record that cleanup is owed, so it goes last. A crash at any earlier step leaves a registration locked by a dead process, which the next run finds in `git worktree list` and replays confined. Every step tolerates work already done: a missing tree, a missing scratch, and an entry already gone. A crash after the last entry is dropped leaves nothing.

What this gives up: the run reads git's administrative layout, the `worktrees/<name>/gitdir` file, instead of asking git. That layout is documented in gitrepository-layout and has not changed since worktrees shipped. A failure to find the common directory, list the entries, or remove one fails the teardown with `worktreeFailed` rather than leaving a registration silently.

Ownership. A stale tree is removed only on proof that a run made it. Its path alone proves nothing: the first rule removed any `melian-static-*/tree` whose lock named no live process, so a user's unlocked worktree at `/tmp/melian-static-feature/tree` was deleted with its directory. The proof is the exact lock reason a run writes, `melian-static pid <pid>`; a process of that pid no longer running; and the marker a run writes into the registration's administrative directory, naming the tree and the pid, when there is one. A live pid always means hands off. Anything else at such a path is left untouched and named in the check's notes. A tree with the exact lock and no marker is a run from a build before the marker, removed as that build would remove it; nothing looser is accepted.

The cross-build rule. A registration format is a stored shape shared with every build that reviews the clone. `git worktree list` covers the whole clone, reviews from several of its worktrees run at once, each from its own build, and each starts by cleaning up stale trees. The build before this one reads a lock with `/^melian-static pid (\d+)$/` under `melian-static-*`. It treats a tree whose lock it cannot parse as crashed. It then deletes the tree and its scratch on the host while the run is live. [Pull request #98](https://github.com/melian-agent/melian/pull/98) lost a mutation run's scratch that way, to a review from a worktree on main, after it changed the lock text. So a format changes only in ways the oldest supported build ignores or reads the same way, with a fixture written by the old version as its test.

- The lock text and the `melian-static-` prefix never change.
- A new fact about a run goes where old builds do not look. The marker is a file beside the lock. It cannot carry a nonce for the lock to match, since the lock cannot change; it records the tree and the pid, which the registration and the lock must match.
- Scratch that only confined cleanup may remove takes a directory prefix old builds skip, `melian-confined-`. An old build that met it under `melian-static-` after a crash would remove it with an unconfined recursive delete. This pull request creates no such scratch; the mutation check will. A dead tree under that prefix needs its marker and a sandbox, and is left with a note without either.
- `test/fixtures/stale-worktrees-v1.ts` holds main's cleanup, copied verbatim from 22a821b2. One test runs it against this build's live run, whose tree, scratch, and output survive and whose run finishes; another runs this build's cleanup against the old build's live run and its dead one.

The file keeps its first name, from the order it first recorded, so links to it hold.
