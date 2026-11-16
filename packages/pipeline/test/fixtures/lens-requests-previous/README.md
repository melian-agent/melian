# Main's version-6 lens task, before lens runs had request keys

Recorded by main at `0129288b`, the merge base of the pull request for [issue #432](https://github.com/melian-agent/melian/issues/432), with `capture.mjs` copied to a worktree of that commit with its own `npm ci --ignore-scripts`, and run with `node --conditions=@melian-agent/source capture.mjs <directory>`. Main's own `reviewChangeset` wrote the store, on fake models only. No stored shape was assembled by hand.

The script builds a two-file change with fixed commit dates, so the reopen test builds the same commits, and reviews it with the built-in `correctness` and `contracts` lenses; `contracts` reports one finding. `state.sqlite` is the closed store, holding a version-6 `melian.lenses` task and a review index entry whose lenses name instruction fingerprints. `recorded.json` holds the commits, the task's version, the verdict, the finding's ID, and the index entry as main wrote it.

The reopen test copies the store into a temporary directory and reviews the same change with the current code. The old task's runs carry no request key, so the review copies none of them and asks each lens once.
