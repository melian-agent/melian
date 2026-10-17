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

## Review indexes

`index-v1.json` records `edbef2a81b3780c1a91974cad5a9c22d27ee1888`, the parent
of the version-2 bump. `index-v2.json` records
`4a60e4538c6243aad96cb9514f3adc5b0abbec85`, the parent of the version-3 bump.
Both captures ran their commit's own `reviewChangeset` with its locked Pi
Durable 1.0.0 install, memory storage and one fake correctness conversation.
The repository changed `notes.txt` from `ready` to `done`, and its full tier
contained only `lens.correctness`. After the review completed,
`harness.snapshot(ReviewIndex, root.id)` supplied the recorded document.

Version 1 keys the entry by head alone. Version 2 keys it by base and head;
its last writer already included the model route before the version bump.
Neither selection has today's scrutiny-level key. Both documents therefore
migrate unchanged, preserving their stale selections and adjudication inputs.
The SQLite tests check every recorded field, then write through version 3 and
reopen again to prove the old entries survive the persisted migration.
