# Version 2 of the probing document, from this branch's own code

Recorded at `c6db71ed`, the last commit of the pull request for [issue #493](https://github.com/melian-agent/melian/issues/493) whose `melian.probing` document is at version 2. `capture.mjs` is `../probing-exit-137/capture.mjs` with its first comment changed. It was copied to the root of a worktree of that commit, with its own `npm ci --ignore-scripts`, and run as `node --conditions=@melian-agent/source capture.mjs <directory>`. That commit's own `reviewChangeset` wrote the store, on fake models and a sandbox that runs probes unconfined. No stored shape was assembled by hand.

The prober runs one probe for attack 1, which exits 137 on its own, reports a finding resting on it, and skips attack 2. Version 2 records a signal apart from the exit, so the stored `exitCode: 137, signal: null` is the probe's own exit.

`state.sqlite` is the closed store. The prober's `melian.probing` document is at version 2, and holds the finding and the probe it rests on. `recorded.json` holds the commits, the lens task's ID, version and result, and the lens's record, as that commit wrote them.

The reopen test opens a copy with the current code. It expects the exit to stay 137, a conclusive failure, and attack 1 to read as answered by the finding.
