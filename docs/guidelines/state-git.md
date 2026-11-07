# State branch guidelines

The state-git package keeps a changeset's Pi storage on the repository's `melian/state` branch, so another clone or an Actions job can carry on a pull request's review. [The state branch decision](../decisions/2026-11-07-state-branch-storage.md) records why it works as it does.

## The objects

- `StateBranch` is one remote's branch, seen from one clone: where the clone keeps its copies, and which clone it is. Its constructor does no I/O.
- `StateBranch.checkout(changeset)` takes the changeset's lease and returns a `StateCheckout`, with this clone's copy as the branch has it. It throws `LeaseHeld` when another clone holds a live lease.
- `StateCheckout.openStorage(context)` opens the copy as Pi's `JsonlStorage`. Close it before `push()`.
- `StateCheckout.push()` stores the copy on the branch and releases the lease. It returns `refused`, with the reason, when another run wrote the changeset; the copy stays, and the next checkout sets it aside for the branch's.
- `StateIndex` is the branch's `index.json`. It parses strictly and refuses a version this build does not read.
- `StateBranchError` carries `fetchFailed`, `pushFailed` or `invalidBranch`.

## The layout

The branch's root holds `index.json` and `changesets/<id>/`. A clone keeps `<directory>/<id>/` for each changeset it works on, beside `<id>.synced`, which names the branch's tree the copy last matched, and any `<id>.set-aside-<time>/` a moved branch displaced.

## Tests

- `test/fixtures/state.ts` builds a bare remote and clones of it, each with a holder and a store directory of its own. `replaceChangeset` moves the remote's branch directly, as a writer that ignores the lease would.
- The conformance suite runs on a checkout's storage, through `registerStorageConformance`.
- `test/push-race.test.ts` lands another run's push between a fetch and its push by wrapping core's `git`; it is the only test that mocks a module.
