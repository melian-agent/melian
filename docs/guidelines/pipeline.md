# Pipeline guidelines

The pipeline package is the only place review flow lives, and the only package that talks to Pi Durable. These rules come from the [Pi Durable spike](../spikes/pi-durable.md).

## The harness wrapper

`packages/pipeline/src/harness.ts` is an import quarantine. It and `src/testing.ts` are the only modules that import Pi Durable, pi-ai, or Chord.

It quarantines import paths, not churn. It re-exports Pi's API unchanged, so callers compile against Pi's experimental contracts: an upstream rename moves one import in the wrapper, but a changed signature still breaks every caller. That is acceptable while the spike's tests are the only callers. As steps 5 and 7 add callers, a narrow Melian-owned facade grows in front of the wrapper, and raw Pi types do not cross out of `packages/pipeline`.

- Re-export Pi's concepts under Pi's names, so Pi's README stays the reference. Give Melian names only to helpers Melian adds, such as `openHarness` and `createFakeModels`.
- Export only what Melian code uses. Add an export in the same change as its first caller.
- Keep test helpers in `src/testing.ts`, published as `@melian-agent/pipeline/testing`. `src/index.ts` exports runtime API only.
- When upgrading Pi, read the changelog and the type declarations, run the spike tests, and update the spike report where behaviour moved.

## The findings document

`FindingsDocument` in `src/findings.ts` holds a conversation's findings keyed by stable ID. It is rewindable and forks `asOf`, so a fork taken at a revision's entry sees that revision's findings and nothing reported after it.

Each ID holds two records. The producer record is what the lens or tool reported: the finding without its status. The lifecycle record is Melian's: `status`, `dismissedBy`, `dismissedReason`, `dismissedAt`, `firstSeenRevision`, `lastSeenRevision`, and a `history` of reopened dismissals. Problem: a lens reports the same finding again on every revision, and an upsert that replaced the whole finding would reset it to `new`. Example: an author dismisses `eval(input)` as safe because the input is a constant; the next push reruns the security lens, which reports it again, and the dismissal vanishes. Solution: a producer only ever writes its own record.

- The document belongs to the changeset's root conversation, never to a lens's child conversation. Problem: a lens conversation ends with its task, and a fork of the root taken to rerun a revision would not carry a document kept in a child, so the next revision would see every finding as new. Solution: `upsertFinding`, `dismissFinding`, and `readFindings` take the root conversation's ID, and step 5's `report_finding` tool is constructed with that ID and writes through it, whichever conversation calls it.
- Write findings only through `upsertFinding(tx, rootConversationId, finding, revision)`. It validates with core's `parseFinding`, replaces the producer record, and keeps the lifecycle record. The lifecycle starts as `new` when the ID is first seen, and `lastSeenRevision` always moves to `revision`. A dismissed finding stays dismissed unless its trigger changed materially, which for now means its normalised `trigger.snippet` differs from the stored one; then its status becomes `new` and the dismissal moves to `history`. A moved or reindented trigger is not material. An invalid finding throws `FindingError` and aborts the whole transaction.
- A replayed or retried `upsertFinding` writes the same state again, so a tool that calls it is an idempotent upsert and can be marked `replay: "safe"`.
- Dismiss with `dismissFinding(tx, rootConversationId, id, { by, reason, at })`. The caller supplies `at`, so a replay writes the same timestamp. An unknown ID throws `FindingError` `unknownFinding`.
- Read with `readFindings`, which merges the two records into core `Finding`s with the lifecycle's status, in ID order, and treats an absent document as empty. It returns deep copies typed `readonly Finding[]`: `snapshot()` hands back the harness's cached document, so a caller that changed a returned finding would change what every later reader sees without a commit.
- The functions take and return core's types. The document token stays inside the package. `upsertFinding` takes Pi's transaction, so its callers, such as step 5's `report_finding` tool, live in the pipeline.

## Check tasks

`runChecks(harness, { rootConversationId, changeset, config, source, tier }, context)` runs a tier's checks on one revision. Core's `checksOfTier` expands the tier: a name that is a tier expands to its checks, and `static` to every static tool. The harness's registry must hold `checksExtension`, in every process that opens the storage, so a check task left pending by a crash resumes.

- One task per check. A `melian.checks` task in the root conversation creates one `melian.check` child per deterministic check, `guardrails`, `static.biome`, or `static.tsc`, and waits on them with `allSettled`, so one failure does not abort the rest.
- Every check writes into the root conversation. A check task commits its findings through `upsertFinding` with the root's ID and the head commit, and its record to the `melian.checks` document, in one commit with its terminal outcome. A crash before that commit reruns the check, which runs the tools on the same commits and upserts the same findings, so the task is replay-safe.
- Every check leaves a record: `ran` with its finding count and notes, `skipped` with a reason, or `failed` with an error code and message. Problem: a check that fails silently looks like a check that found nothing, and adjudication would call the revision clean. Solution: a failed check writes no findings and a `failed` record, and adjudication reports the revision as not reviewed by it. A `lens.*` or `decisions.*` name is recorded as skipped, since those run elsewhere; any other unknown name fails with `unknownCheck`.
- Asking twice runs once. The `melian.checks` document maps `<head> <tier>` to its task, so a second `runChecks` for the same revision and tier, from this process or a new one, waits for the first task instead of starting another.
- Static checks get their environment from the harness's `env` option through `runtime.env()`. A durable task's input is JSON, so it cannot carry a live environment; a task resumed in a new process finds the new process's environment the same way. A harness without one fails each static check with `noEnvironment`.
- `config` is the repository root's configuration, read from `source`. It names the tier's checks and the static tools' settings; each finding's resolution comes from its own path's configuration.

## Static tools run in the execution environment

`runStaticTool` in `src/static.ts` runs Biome or tsc on one commit. Everything it executes goes through an `ExecutionEnv`, Pi Durable's `FileSystem` plus `Shell`, never through the Melian process. Biome and tsc load the repository's configuration and plugins, so running them runs the revision's code. Version one passes `createNodeExecutionEnv`, because a local run reviews the maintainer's own code; a container environment implements the same interface and replaces it without touching the runner.

- One worktree per revision. The runner checks the commit out with `git worktree add --detach` into a temporary directory, runs the tool there, and removes the worktree in a `finally`. Never run a tool against the user's checkout: its working tree holds whatever is checked out, edits included, and the tool would review that instead of the commit. Because the tool runs in the revision's tree, it reads the revision's own `biome.json` or `tsconfig.json` by construction.
- Cleanup never takes the caller's context. Problem: a cancelled context makes every `ExecutionEnv` call return `aborted` at once, so the `finally` left the worktree registered. Solution: removal runs under `backgroundContext`.
- A crashed run's worktree is removed by the next run. Problem: after SIGKILL the worktree's directory still exists, so `git worktree prune` keeps it registered for good. Solution: the runner adds each worktree with `--lock` and the reason `melian-static pid <pid>`. Before adding its own, it reads `git worktree list --porcelain -z` and removes, with `--force --force`, every `melian-static-*` worktree whose locking process `kill -0` no longer finds. A live run's worktree stays. `test/static.test.ts` kills a run parked in `test/fixtures/static-crash.ts` and checks that the next run removes what it left.
- git runs with the hook's repository variables unset, `core.hooksPath=/dev/null`, and `core.fsmonitor=false`. Problem: `git worktree add` runs the post-checkout hook, and a repository using husky points `core.hooksPath` at a directory the revision controls. Solution: no hook runs during checkout, so nothing executes outside the tool's timeout.
- A worktree has no `node_modules`. The runner links the checkout's into it, so tsc resolves the repository's dependencies, and uses `node_modules/.bin/<tool>` when it is there; otherwise it runs the Biome or tsc Melian depends on. Workspaces' nested `node_modules` are not linked.
- Bounds are failures. `static.<tool>.timeout` (300 seconds by default) caps each command, and `ulimit -f` with a check before reading caps what the tool writes at `staticOutputLimit` (16 MiB). A timeout, a crash, an unexpected exit, a missing report, or output too large is a `CheckError` with its code, never an empty log.
- Output goes to files, not the shell's stream. `Shell.exec` interleaves stdout and stderr, which would corrupt a JSON report, so the runner redirects each tool to a file in its scratch directory and reads that.

## Contracts that read like mistakes

- A task phase reruns from its start after a crash. Work before the phase's checkpoint commit must be safe to repeat, or guarded by a durable record.
- A tool's own commit and its result land in separate durable commits, so a crash between them reruns a replay-safe tool and has the model retry an unsafe one. A tool with a durable side effect is therefore an idempotent upsert keyed by a stable ID, such as a finding's, and marked `replay: "safe"`. Otherwise it is not replay-safe, and a durable record guards its side effect. Never guard it with a memo.
- A phase must commit a new checkpoint or a terminal outcome. Returning without one faults the task.
- `memo()` belongs to one task, a tool call included, and is deleted when that task ends. Use it for intent within a task, never as a record that outlives the run.
- A conversation created by a task starts as a copy of its owner's agent. Set a lens's `tools` explicitly, or it inherits the orchestrator's.
- Lenses run as conversations owned by the lens task, which decides which lenses run. A model never chooses the topology through a subagent tool.
- Conversation IDs are numbers minted by storage. A `requestId` deduplicates within one conversation only.
- The tool task coerces arguments towards the schema before validating: `42` becomes `"42"` for a string field. Constrain a schema with formats, patterns, or lengths when coercion would let a bad value through.
- A fork taken before a document's first write has no document. Treat an absent document as its initial value.
- `waitForTask()` resolves at the task's terminal commit, before the phase function returns. Code after that commit in the phase may not have run yet; `close()` waits for it.

## Tests

- Use the fake model from `createFakeModels()` in `src/testing.ts`. Never a real provider, key, or paid token.
- Use memory storage unless the test is about surviving a reopen or a crash. Then use SQLite in a temporary directory and delete it afterwards.
- Close every harness in `afterEach`, before deleting its directory, so a failed assertion does not leave a live SQLite handle. `close()` is idempotent.
- Test a crash with a real process kill. Run the first half in `test/fixtures/crash.ts`, have it append events to a log synchronously, SIGKILL it at a known event, and resume in the test process against the same file. Count reruns from the log.
- The parent polls that log while the child writes it, so ignore text after the last newline: it is an event still being written. Detect an early death through `signalCode` as well as `exitCode`, which stays null when a signal kills the child, and kill the child in a `finally`.
- A fake reply carrying tool calls needs `stopReason: "toolUse"`; the default `"stop"` ends the run without running them.
- Assert on what the model was shown, not only on what the harness returned. `captured()` in `test/fixtures/spike.ts` keeps each request's messages.
