# The state branch stores each pull request's JSONL storage, and a lease keeps one writer

Status: built for [issue #244](https://github.com/melian-agent/melian/issues/244), in two pull requests: the `state-git` package first, then the CLI. The maintainer ruled the two choices under Rulings in the builder's session on 2026-11-07, as [the issue's comment](https://github.com/melian-agent/melian/issues/244#issuecomment-6706989407) records.

Amends: [the coverage ledger decision](2026-10-23-coverage-ledger-and-delta-review.md), its "Sharing, for milestone 3" section: the state branch lands before the ledger, which [issue #307](https://github.com/melian-agent/melian/issues/307) carries onto it, and the lease is taken by this clone's checkout of a changeset

## Problem

Only the coordinator's clone holds a pull request's storage: its rounds, its marker secret, its ledger comment ID and its dismissals. A builder's Actions round throws its store away, so it cannot publish, resolve a thread or keep a dismissal. Losing that one clone loses all of it, the risk-table row "losing the one clone that reviews Melian".

## Rulings

1. A pull request's working store is Pi's `JsonlStorage`, in a directory this clone keeps for the state branch. A range stays on SQLite. The alternative, pushing the SQLite file itself, would leave every reader alone but add a whole binary blob to the branch at every publish.
2. A pull request that already has a local SQLite store keeps using it, with no lease and no push, and Melian says so. Pi has no generic copy of one store into another backend. A fresh store would mean a new marker secret, an orphaned ledger comment and lost dismissals. Open pull requests finish within days, so the old path empties itself.

## The branch

`melian/state` on the repository's own remote holds two things at its root. `index.json` is the state index. `changesets/<id>/` holds one changeset's storage, the files Pi's JSONL backend writes and no others: `main.jsonl`, `doc-<n>.jsonl` and `task-<n>.jsonl`. A tree holding any other name, mode or kind is refused before a byte of it is written locally, since anyone with push permission can write the branch.

Melian builds each commit with git's plumbing: `hash-object`, `mktree` and `commit-tree` in the clone's own object database. It never checks the branch out. Problem: [the design](../design.md#state-storage) planned a worktree of the branch, but one clone can review two pull requests at once, and a checkout of the branch would rewrite the other changeset's files under its open storage. Solution: each changeset's copy is a plain directory, and only the branch's trees join them.

## The lease

The index holds a lease per changeset another run may be working on: the run, the clone that holds it, when it was taken, and how many times it has been taken. A checkout fetches the branch, refuses with `LeaseHeld` when another clone's lease is under two hours old, and otherwise takes the lease by pushing the index. A lease of the checkout's own clone is taken over, since only a crashed run of that clone leaves one. A lease two hours old or more is taken by anyone. A long review that outlives its lease is still safe, because the push below checks both the lease and the changeset.

Every push names the tip it fetched with `--force-with-lease`. When the remote reports stale info, another run pushed in between, so the run fetches again and decides afresh: a run on another changeset never blocks this one. After three moves in a row it gives up with `pushFailed`. A refusal for any other reason, such as a hook or branch protection, is `pushFailed` at once.

## Pushing and resuming

A push stores this clone's copy of the changeset and releases the lease, in one commit. It is refused, and the copy stays as it is, when the lease is no longer this run's, or when the changeset's tree on the branch is not the one this clone last synced with. Either way another run has written the changeset.

The next checkout sees that the branch has moved past this clone's copy, sets the copy aside beside it and takes the branch's. The branch's copy decides what is done, so a resumed review attaches to the tasks the other run finished and redoes only what the branch lacks. Pi's JSONL log is one writer's history, so two copies are never merged.

A store a newer build wrote is refused when this build opens it, by Pi's document versions, as today. The branch is not overwritten: a push after the refusal stores the copy unchanged.

## What this gives up

- The lease is no lock. A run that holds the lease longer than two hours can be raced; the push then decides, and the loser redoes its delta.
- A set-aside copy stays in the clone until someone deletes it.
- The lease lives on the branch, so every checkout and every push is a network round trip, a second or so against reviews that take minutes.
