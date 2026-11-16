# Version-7 and version-8 lens task inputs, for the version-9 reopen

`v7.json` was recorded by main at `2304de2a`, and `v8.json` by the pull request for [issue #493](https://github.com/melian-agent/melian/issues/493) at `c9201e45`, the first commit to store version 8. For each, `capture.ts` was copied to the root of a worktree of that commit, with its own `npm ci --ignore-scripts`, and run as `node --conditions=@melian-agent/source capture.ts <file>`. That commit's own `reviewChangeset` stored the task, on fake models, and `Harness.getTask` read it back. No stored shape was assembled by hand.

The review routes `heavy` to a first model that fails and one bare fallback, at `thinking: low`, so each stored run's route holds two models and names no level of its own. `test/fallback-levels-reopen.test.ts` creates each input under a token of its recorded version, reopens it under the current definition, and expects the fallback asked at `low`, the run's level, as that version asked it.
