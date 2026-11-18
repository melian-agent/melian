# Issue 570: the gate reads every mutation inventory

[Issue #570](https://github.com/melian-agent/melian/issues/570). A builder commits a mutation inventory under `docs/progress-log/` so a reviewer can spot-check it with `node scripts/enumerate-mutants.mjs --sample`. Nothing read the file until a review of record tried to. On [pull request #537](https://github.com/melian-agent/melian/pull/537), [pull request #552](https://github.com/melian-agent/melian/pull/552) and [pull request #566](https://github.com/melian-agent/melian/pull/566) it could not, and #552's inventory merged that way.

`scripts/check-inventories.mjs` now runs in `npm run check`. A JSON file in the log is an inventory when its top level holds a `melianMutants` or `mutants` key, the keys every inventory writer emits; run logs and other records go unchecked. The check hands each inventory to `sampleMutants`, the sampler's own reader, and fails with its message on one it refuses. It checks every inventory, not only those a change touches, so it needs no history beyond `origin/main`, which CI fetches.

`.unreadable-inventories.json` lists the 56 merged inventories the reader refuses today, 17 at version 2 and 39 legacy, each with its pull request. The list only shrinks: the check fails on an entry the sampler now reads, on one that names a missing file or no inventory, on one filed under the wrong version, and on any entry that `origin/main`'s copy of the list lacks or files under another version or pull request, and on a listed file whose text differs from `origin/main`'s copy, so no one can empty or replace an inventory the list excuses. Before main has a list, as on this pull request, there is nothing to compare with; where `origin/main` cannot be read, the check fails and says to fetch it.

The 39 legacy files fail for three reasons, none an older shape the reader was meant to keep reading:

- 17 carry fields the legacy schema does not allow, mostly a `run` record on each row and notes such as `base`, `head`, `command` and `counts` at the top.
- 16 leave a row that owes a claim without one.
- 6 are hand-written, with no `total` or `omitted`, so the reader cannot tell they are complete.

The coordinator chose the shape test and the whole-log scan on 2026-11-18. It guards no trust or durability, so it owes tests and no hand mutation proof. `scripts/check-inventories.test.mjs` covers a refused inventory, with the sampler's message, a readable one, a run log, each way the list can go stale, and the gate's command end to end. The test of the committed log fails until the list names every refused inventory: run first, it found #552's, which merged after the scan, and after a merge of `main` four from [pull request #515](https://github.com/melian-agent/melian/pull/515).
