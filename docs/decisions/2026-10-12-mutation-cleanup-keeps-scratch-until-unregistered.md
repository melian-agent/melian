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

The file keeps its first name, from the order it first recorded, so links to it hold.
