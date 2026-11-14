# State branch guidelines

`packages/state-git` is the git adapter of core's `RecordStore`, `GitRecordStore`. It keeps the shared record on the repository's `melian/state` branch, by rule 12 of [the shared record decision](../decisions/2026-11-13-shared-record-behind-a-store-port.md) and [the decision that amends it](../decisions/2026-11-14-git-record-store-refuses-by-location.md). Read both before changing it.

## How it works

- `RecordRepository` is a bare repository of Melian's own, `records.git` in the clone's state directory. It is never the clone: a fetch writes nothing into the clone's refs, and the clone is never made shallow.
- Every call fetches the branch's tip alone, `--depth=1`, into a ref of its own, and deletes the ref. Two processes can share one `records.git`; a lock another fetch holds is retried.
- `StateTree` judges every entry of the fetched tree before a call answers or builds a commit. An entry is known when it is a mode `100644` file at `changesets/<changeset>/cell.json` holding a cell Melian writes, or at the path a record's own bytes give. A stray in one changeset's folder refuses that changeset; a stray anywhere else refuses every changeset. A handle remembers what it judged by object ID and path, so it reads each blob once.
- A write builds one commit with `read-tree`, `hash-object`, `update-index` and `commit-tree` on a temporary index, and pushes it with `--force-with-lease` on the tip it read. A lost race waits a random time below a bound that doubles from 50 ms to 8 s, and reads again, until the deadline.
- A push stopped at its deadline counts as landed only when its commit is the tip or an ancestor of it. The check deepens its fetch until the history holds the commit, holds the tip the commit was built on without it, or ends.

## Rules

- Run git only through `RecordRepository.run`. It checks the repository's configuration bytes and passes `overrides`, the settings that would run a program or start background work. A new setting with that power goes on that list with a one-line reason, and a test proves it holds with the configuration check mocked out, as `test/overrides.test.ts` does.
- Never read a stray entry's bytes into a record, and never rewrite or remove one. A commit carries it along by its object ID.
- A failure to reach or answer from the remote is `RecordError` `unreachable`; never answer from a tree read in part.

## Testing

- `test/fixtures/remote.ts` makes a bare remote in a temporary directory and opens handles with state directories of their own, as hosts are. `Remote.plant` commits entries by hand, as a writer outside Melian would.
- A local `file://` remote inherits the client's `-c` settings through `GIT_CONFIG_PARAMETERS`, so a hook in the test remote never runs. Stand in for a slow or refused push with a spy on `RecordRepository.prototype.push` that calls the real push, or plants a commit, before it answers.
