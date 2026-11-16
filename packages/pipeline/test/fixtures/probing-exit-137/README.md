# Main's probe records of a signal, written as exit 137

Recorded by main at `374fdaf7`, the merge base of the pull request for [issue #493](https://github.com/melian-agent/melian/issues/493). `capture.mjs` was copied to the root of a worktree of that commit, with its own `npm ci`, and run as `node --conditions=@melian-agent/source capture.mjs <directory>`. Main's own `reviewChangeset` wrote the store, on fake models and a sandbox that runs probes unconfined. No stored shape was assembled by hand.

Main's bubblewrap runner reported a probe a signal ended as exit 128 plus the signal's number, with no signal. The script stands in for a SIGKILL with a probe that exits 137. The prober runs it for attack 1, reports a finding resting on it, since main reads 137 as a failure, and skips attack 2. The review runs the probe again before verification.

`state.sqlite` is the closed store. The prober's `melian.probing` document and the root's `melian.probe-reruns` document each hold, at version 1, a result of `exitCode: 137, signal: null`. `recorded.json` holds the commits, the lens task's ID, version and result, and the lens's record, as main wrote them.

The reopen test opens a copy with the current code and expects both results to read as a probe that ended with no record of how, which shows nothing.
