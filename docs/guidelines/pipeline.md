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

- Write findings only through `upsertFinding(tx, conversationId, finding)`. It validates with core's `parseFinding`, then stores the finding under its ID, replacing any finding with that ID. A replayed or retried call writes the same value again, so a tool that calls it is an idempotent upsert and can be marked `replay: "safe"`. An invalid finding throws `FindingError` and aborts the whole transaction.
- Read with `readFindings`, which returns findings in ID order and treats an absent document as empty.
- Both take and return core's `Finding`. The document token stays inside the package. `upsertFinding` takes Pi's transaction, so its callers, such as step 5's `report_finding` tool, live in the pipeline.
- Replacing is right while every finding is `new`. Cross-revision diffing will need an upsert that keeps a finding's status, such as `dismissed`, when a later revision reports it again.

## Credentials

`createReviewModels()` builds the pi-ai model collection a review runs on: every built-in provider, resolving credentials as pi-ai does, a stored credential first and the provider's environment variables second. The store is `piCredentialStore()`, which reads Pi's `auth.json`, the file `pi` writes on `/login`: `$PI_CODING_AGENT_DIR/auth.json`, or `~/.pi/agent/auth.json`. One `pi` login covers Melian.

The store is read-only, and that has two consequences that read like bugs:

- An expired OAuth login fails with "run pi to refresh". pi-ai refreshes a token by writing it back through the store, and providers such as Anthropic rotate the refresh token on every refresh. A Melian that refreshed in memory without writing would leave Pi holding a dead refresh token.
- A key Pi resolves at use, `!command` or one containing `$VAR`, reads as absent, so the provider's environment variable applies. Melian runs no commands from a credential file.

There is no credential pool yet; one credential per provider.

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
