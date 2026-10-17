# Recorded migration inputs

`check-v1.json` records the running `melian.check` task written at
`2d20efd74106f8a9ba80368000d0390172dc6ae4`, the parent of the task's version-2
bump. Its input already has the run identity and base/head revision. Version 2
changed the result record, not the input or checkpoint conversion.

The capture used a detached scratch worktree and `npm ci` from that commit's
lockfile, including Pi Durable 1.0.0. A Vitest test ran that worktree's
`runChecks` with memory storage and fake models. Its repository had a `fast`
tier containing `guardrails`, a `todo` forbidden-pattern rule, and a head that
changed `notes.txt` from `ready` to `TODO`. A storage `commit` wrapper copied
the running task write before forwarding it. The writer completed with one
finding. No stored field was assembled by hand.

The reopen test remaps the repository path and commit IDs, creates the task
through a token of its recorded version, closes SQLite, and resumes today's
checks extension. It checks the complete input, guardrail finding, run record
and unavailable timing. No old checks document is imported: that document's
versions 1 and 2 are deliberately refused by the current definition.
