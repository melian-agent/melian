# A version-5 verification task input, for the version-6 reopen

`v5.json` is the first verification wave's task, recorded at `2c95bf3b`, the head of [issue #481](https://github.com/melian-agent/melian/issues/481)'s branch, which stores version 5. It was recorded with the same `capture.ts` and the same command as `../verification-v4-main/`, whose README holds the script, in a worktree of that commit. That commit's own `reviewChangeset` stored the task on fake models, and `Harness.getTask` read it back. No stored shape was assembled by hand.

The review routes the verifier to a first model that fails and one bare fallback, at `thinking: low`, and shows the verifier no dismissal, so the candidate names no record. `test/verification-v6-reopen.test.ts` creates the input under a version-5 token, reopens it under the current definition, and expects the fallback asked at `low`, the candidate's level, as version 5 asked it.
