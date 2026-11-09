# Recorded version-10 findings

`state.sqlite` was written by main's code at `d4e8d8df` (Merge pull request #332), whose findings document is version 10.
The recorder, `write.ts`, uses that commit's `upsertFinding`, `upsertVerification` and `dismissFinding`.
It records one introduced lens claim, a confirmed verification, and a maintainer's dismissal of it at `base..accepted`.
`findings.json` is the snapshot the recorder printed, with the root conversation's ID.

The recording ran in a detached worktree of that commit, with `node --conditions=@melian-agent/source`.
Its `node_modules` linked the checkout's installation, with every `@melian-agent` package pointed at the worktree's own sources.
No stored shape is written by hand. Do not re-record it with a later build.

The reopen test copies the file to a temporary directory and opens it with version 11.
The dismissal and the verification read back unchanged, with no recorded severity, so the dismissal never carries.
