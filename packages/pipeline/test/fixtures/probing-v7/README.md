# Main's version-7 lens task, from a probing run whose only probe showed nothing

Recorded by main at `374fdaf7`, the merge base of the pull request for [issue #493](https://github.com/melian-agent/melian/issues/493). `capture.mjs` was copied to the root of a worktree of that commit, with its own `npm ci`, and run as `node --conditions=@melian-agent/source capture.mjs <directory>`. Main's own `reviewChangeset` wrote the store, on fake models and a sandbox that runs probes unconfined. No stored shape was assembled by hand.

The script builds a one-file change with fixed commit dates, so the reopen test builds the same commits. It reviews the change with the `trust-boundary` lens at a deep level that probes. The planner plans two attacks. The prober runs one probe for attack 1, which a SIGKILL ends, and skips attack 2. Main counts attack 1 as answered, so its task stores `skipped: 1` as a count and `unanswered: []`, and its record reads `ran`.

`state.sqlite` is the closed store, holding the completed version-7 `melian.lenses` task. `recorded.json` holds the commits, the task's ID, version and result, and the lens's record, as main wrote them.

The reopen test copies the store into a temporary directory and reviews the same change with the current code. A finished probing run is never reused, so the review probes again. It reads attack 1, whose only probe showed nothing, as one with no answer.
