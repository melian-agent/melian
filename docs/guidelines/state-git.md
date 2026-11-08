# State branch guidelines

The state-git package keeps a changeset's Pi storage on the repository's `melian/state` branch, so another clone or an Actions job can carry on a pull request's review. [The state branch decision](../decisions/2026-11-07-state-branch-storage.md) records why it works as it does.

## The objects

- `StateBranch` is one remote's branch, seen from one clone: where the clone keeps its copies, which clone it is, and the writers' 32-byte key every file on the branch is sealed under. Its constructor does no I/O, and refuses a key of any other length with `invalidKey`.
- `StateBranch.checkout(changeset)` takes the changeset's lease and returns a `StateCheckout`, with this clone's copy as the branch has it. It throws `CopyInUse` while another process in this clone works on the changeset, and `LeaseHeld` while another clone holds a live lease. Close the checkout when the work is done, pushed or not; `close()` releases the clone's lock, an exclusive SQLite transaction on `<id>.lock`.
- `StateCheckout.directory` is the copy. The CLI opens it with the pipeline's `openJsonlStorage`, since only the pipeline's wrapper imports Pi; close that storage before `push()`.
- `StateCheckout.incarnation` and `StateCheckout.generation` name the lease this checkout writes under. `StateCheckout.push()` stores the copy on the branch, recording both, and releases the lease; a lease the index no longer holds, by incarnation or generation, is refused. It returns `refused`, with the reason, when another run wrote the changeset; the copy stays, and the next checkout sets it aside for the branch's.
- `StateIndex` is the branch's `index.json`: each changeset's core `Lease`, with its incarnation, the generation of its latest write within that incarnation, and the writers' key commitment. A push expires a lease and keeps it, so its generation survives. It parses strictly and refuses a version this build does not read.
- `StateBranchError` carries `fetchFailed`, `pushFailed`, `invalidBranch` for a branch this build or this key cannot read whole, `invalidCopy` for a local copy holding what Pi's storage never writes, `invalidKey`, or `invalidHolder`.

## The layout

The branch's root holds `index.json` and `changesets/<id>/`. A clone keeps `<directory>/<id>/` for each changeset it works on, beside `<id>.synced`, which names the branch's tree the copy last matched, `<id>.lock`, and any `<id>.set-aside-<time>/` a moved branch displaced. A checkout keeps the copy only when it still holds the synced tree whole: its main log starts with the tree's, and `StateBranchOptions.validate`, which the CLI implements with Pi's own storage, opens it. Otherwise it sets the copy aside and restores the branch's. A push judges the bytes it pushes the same way, from a directory of their own, and refuses with `invalidCopy` a copy that no longer holds the synced tree whole. Fetch and push run with no credential prompt and with git's low-speed limit, so an unanswered prompt or a stalled transfer reads as an unreachable branch.

## Tests

- `test/fixtures/state.ts` builds a bare remote and clones of it, each with a holder and a store directory of its own. `replaceChangeset` moves the remote's branch directly, as a writer that ignores the lease would.
- The conformance suite runs on a checkout's storage, through `registerStorageConformance` from `@melian-agent/pipeline/testing`, which also gives the tests Pi's `createSession`.
- `crash(clone)` checks out in a child process that exits without closing, as a crash does. Each remote has a random key its clones share; pass `key` to a clone to give it another.
- `test/push-race.test.ts` lands another run's push between a fetch and its push by wrapping core's `git`; it is the only test that mocks a module.
