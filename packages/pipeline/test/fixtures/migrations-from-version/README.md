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

## A check that runs a tool

`check-v3.json` records the `melian.check` task for `static.biome` that main
wrote at `088aa41f1da8eb250aefcaf28ae930f69a9a5bee`, before a check's input
carried the `LANG` its run's key read. A Vitest test in a detached worktree of
that commit, borrowing the checkout's `node_modules`, ran that commit's own
`runChecks` from its `src` with memory storage, fake models and a `fast` tier of
`static.biome` alone. Its repository changed `src/a.ts` from `a = 1` to
`a = 2`. After the run completed, `storage.task` supplied the stored input,
which has no `lang`. The reopen test in `test/check-lang.test.ts` remaps the
repository path and commits, creates the task through a token of version 3,
closes SQLite, and resumes today's checks extension under another `LANG`,
which the tools then run with.

## A tier that runs a tool

`checks-v2.json` records the `melian.checks` task that main wrote at
`088aa41f1da8eb250aefcaf28ae930f69a9a5bee`, before its input carried `lang`.
A Vitest test in a detached worktree of that commit, with `npm ci` from its
lockfile, ran that commit's own `runChecks` with memory storage, fake models,
a node execution environment and a `fast` tier of `static.biome` alone, on the
same repository change as `check-v3.json`. After the run completed,
`storage.task` supplied the stored kind, version and input. The checkpoint is
not recorded: the reopen test creates the task through a version-2 token whose
`initial` is main's, `{ phase: "start" }`. The test in
`test/check-lang.test.ts` remaps the repository path and commits, closes
SQLite, and resumes today's checks extension under another `LANG`. The task
migrates to version 3, and its check runs with the process's `LANG`.
