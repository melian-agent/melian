# Main's version-7 lens task, before a copy could name an imported record

Recorded by main at `1dc69f73`, the merge base of the pull request for [issue #475](https://github.com/melian-agent/melian/issues/475), with `capture.mjs` copied to a worktree of that commit with its own `npm ci --ignore-scripts`, and run with `node --conditions=@melian-agent/source capture.mjs <directory> 1dc69f73`. Main's own `reviewChangeset` wrote the store, on fake models only. No stored shape was assembled by hand.

The script is the one beside the version-6 fixture in `lens-requests-previous`, with the commit taken from its arguments. It builds a two-file change with fixed commit dates and reviews it with the built-in `correctness` and `contracts` lenses; `contracts` reports one finding. `state.sqlite` is the closed store, holding a version-7 `melian.lenses` task whose runs carry request keys. `recorded.json` holds the commits, the task's version, the verdict, the finding's ID, and the index entry as main wrote it.

The reopen test copies the store into a temporary directory and reviews the same change with the current code under version 8. The old task's runs carry request keys, so the new task copies both from it, naming its task and nonce, and asks no lens.
