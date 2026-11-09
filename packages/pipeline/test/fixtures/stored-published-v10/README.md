# Recorded version-10 publication

`state.sqlite` was written by main's code at `aafa199b` (Merge pull request #353), whose published document is version 10.
The recorder, `write.ts`, reviews the GitHub scenario, publishes it, dismisses the `null-dereference` finding, and publishes again through a fake GitHub.
The second publication closes that finding in the ledger's current round, with its reason.
`published.json` is the snapshot the recorder printed, with the root conversation's ID.

The recording ran in a detached worktree of that commit, with `node --conditions=@melian-agent/source`.
Its `node_modules` linked the checkout's installation, with every `@melian-agent` package pointed at the worktree's own sources.
No stored shape is written by hand. Do not re-record it with a later build.

The reopen test copies the file to a temporary directory and opens it with version 11.
It reads back unchanged, and once rewritten a version-10 definition refuses it.
