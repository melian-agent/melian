# Spike: Pi Durable against the design

Step 2 of milestone 1, tracked in [issue #2](https://github.com/melian-agent/melian/issues/2). The design assumes `@earendil-works/pi-durable` 1.0.0 behaves as its announcement describes. This spike tested that assumption against the package itself: its README, its type declarations, and twelve Vitest tests that run it on the fake model with no credentials.

## Verdict

The design holds. Pi Durable 1.0.0 did everything the spike asked of it, and nothing needed a workaround inside the harness. Four rows of the "Mapping onto Pi Durable" table in [design.md](../design.md) say something the package does not, and need rewording before steps 5 and 7 build on them:

1. A changeset's conversation cannot be keyed by repository and changeset. Pi mints conversation IDs.
2. A lens should be a conversation owned by the lens task, not a subagent tool the model chooses to call.
3. `api.memo()` belongs to one task and is deleted when that task ends. It cannot deduplicate publication across runs on its own.
4. The `Storage` interface is larger than "one atomic `commit(writes)` plus reads", and has no cross-process locking.

No row needs a different harness. The proposed wording is under [Proposed changes to design.md](#proposed-changes-to-designmd).

## What each test proved

The tests live in [packages/pipeline/test/durable-spike.test.ts](../../packages/pipeline/test/durable-spike.test.ts). Crash tests run the first half of a scenario in a child process, [packages/pipeline/test/fixtures/crash.ts](../../packages/pipeline/test/fixtures/crash.ts), kill it with SIGKILL at a known point, and resume against the same SQLite file in the test process. Each counts executions through a JSON-lines log the child appends to synchronously, so a rerun is visible as a second line.

| Test | Proved |
|---|---|
| a. Open and resume | A SQLite harness closed and reopened returns the same root conversation ID, the same transcript, the same settled submission, and the stored model choice. |
| b. Task checkpoints survive a crash | A two-phase `defineTask()` killed during phase two resumes in phase two. Phase one ran once. Phase two started twice and finished once, so a phase reruns from its own start. |
| c. Replay policy | After SIGKILL mid-call, the `replay: "safe"` tool ran again and its result reached the model. The unsafe tool did not rerun; the model received an error result reading `Tool unsafe_probe was interrupted and may have partially run`. |
| d. Child conversation | A tool created a task-owned child conversation, gave it its own model, instructions, and an empty tool list through `configure()`, submitted the question, and returned the child's answer to the parent model. The child's request carried the lens instructions and offered no tools; the parent's did not carry them. |
| d2. Lens fan-out from a task | A `defineTask()` created one owned child conversation per lens in a single commit, checkpointed their IDs, then ran both lenses in parallel and completed with their answers. The orchestrating conversation's model was never called. This test was not in the brief; it was added because test d exposed the topology problem in row 2 of the verdict. |
| e. Typed tool | `defineTool()` types `args` from its TypeBox schema. A call with `line: 0` and a call missing `path` were rejected before `execute()` ran, with messages such as `line: must be >= 1`. A call with `path: 42, line: "12"` was coerced and ran with `path: "42", line: 12`. |
| f. Documents | A rewindable `defineDoc()` with `fork: "asOf"`, written inside a tool's `api.commit()`, was readable after reopen. A fork at the tool-result entry saw the finding; a fork at the preceding tool-call entry did not; neither saw a write made to the parent after the fork. `snapshotAsOf()` agreed at both entries. |
| g. Memo | A replay-safe tool memoised a candidate, was killed, and on rerun offered a different candidate twice. Both calls returned the first. Once the tool call finished, its task record held no memos. |
| h. Exactly-once submission | Two submissions with one `requestId` returned the same submission ID, and so did a third after reopen. The model was called once and the transcript holds one user entry. |
| i. Prompt sections | A `section()` that reads a file rendered the new contents in the next request after the file changed. The transcript holds two `pi.system` entries, one per version. |
| Hook | `hook(ToolTask, { beforeTool })` blocked a call before `execute()` ran; the model received `Tool call blocked: lenses are read-only`. |

[packages/pipeline/test/harness-boundary.test.ts](../../packages/pipeline/test/harness-boundary.test.ts) fails the gate if any file under `packages/` other than the wrapper imports Pi Durable or Chord.

Nothing was marked `it.todo`. Every behaviour the brief listed exists in 1.0.0.

## Surprises

**Pi's `source` export condition broke Vitest.** Pi's packages publish a `source` condition that points at a `src/` directory they do not ship. Melian's Vitest configuration resolved workspace packages through a condition of the same name, and Vite applies a custom condition to every package, so the first Pi import failed with `Cannot find module .../chord/src/index.ts`. Melian's condition is now `@melian-agent/source`. `tsc` was unaffected.

**The fake model is in pi-ai, not pi-durable.** `@earendil-works/pi-durable/testing` holds the storage conformance suite and benchmarks. The fake model is pi-ai's `fauxProvider()`, registered in a `createModels()` collection. The wrapper's `createFakeModels()` does both.

**A fake reply runs its tool calls only with `stopReason: "toolUse"`.** `fauxAssistantMessage()` defaults to `"stop"`, and a reply carrying a tool call with that stop reason ends the run without running the tool.

**Arguments are coerced before validation.** The tool task converts arguments towards the schema, so a number becomes a string and a numeric string an integer. `report_finding` will accept loosely typed calls; a schema that must reject them needs constraints coercion cannot satisfy, such as `minLength` or a pattern.

**A phase reruns from its start.** Work inside a phase before its checkpoint commit repeats after a crash. Each phase must be safe to repeat, or guard its side effect with a memo.

**Memos are per task and temporary.** `TaskRecord.memos` is documented as "small first-writer-wins values retained while the task can run", and test g shows them gone once the task is terminal. `api.memo()` in a tool is the tool task's memo, not the pipeline's.

**Conversation IDs are numbers minted by storage.** The root conversation is the reserved ID 1. There is no lookup by name or key.

**A child conversation inherits its owner's agent.** A task-owned conversation starts as a copy of the owner conversation's model, extensions, and tools. A lens must set `tools` explicitly, or it can call whatever tools the orchestrator offers, including the one that spawned it.

**A fork before a document's first write sees no document.** `snapshot()` returns `undefined`, not the initial value. Readers treat absent as initial, as the README advises.

**The README's examples are not in the npm package.** It links `test/examples/*.ts`, which the published tarball omits. Read them in the Pi repository.

**Every call takes a Chord `Context`.** The wrapper exports `backgroundContext` for callers with nothing to cancel.

## API used

Through [packages/pipeline/src/harness.ts](../../packages/pipeline/src/harness.ts), which re-exports Pi's names unchanged so Pi's README stays the reference, and adds five of its own.

- Wrapper additions: `openHarness`, `openSqliteStorage` (over `openNodeSqliteStorage`), `createMemoryStorage` (over `MemoryStorage`), `createFakeModels` (over pi-ai's `fauxProvider` and `createModels`), `backgroundContext` (Chord's `BACKGROUND_CONTEXT`).
- Definitions: `createRegistry`, `defineExtension`, `defineTool`, `defineTask`, `defineDoc`, `section`, `hook`, `ToolTask`, `configure`, `AssistantEntry`, `SystemEntry`, `ToolResultEntry`, pi-ai's `Type`, `fauxAssistantMessage`, `fauxToolCall`.
- `Harness`: `root`, `conversation`, `submission`, `commit`, `snapshot`, `snapshotAsOf`, `getTask`, `waitForTask`, `waitForIdle`, `resume`, `close`.
- `Conversation`: `submit`, `commit`, `context`, `agent`, `fork`. `Submission`: `id`, `wait`, `status`.
- `Tx`: `createTask`, `createConversation`, `scanConversations`, `doc`, `entry`.
- `TaskRuntime`: `commit`, `conversation`, `context`, `taskId`. `ToolExecutionApi`: `commit`, `memo`, `conversation`, `taskId`, `conversationId`.

## Not exercised

These rows or features exist in the 1.0.0 types but no test touched them: `whenBusy: "steer"`, the `ExecutionEnv` interface, JSONL storage, compaction, conversation and task abort, and a crash during the lens fan-out in d2. None is on the path before step 5.

## Proposed changes to design.md

These are proposals; [design.md](../design.md) is unchanged by this spike.

**Mapping table, first row.** From "One conversation, keyed by repository and changeset identity, persisted by ID across restarts" to: "One conversation per changeset. Pi mints conversation IDs, so Melian keeps the map from changeset to conversation: one storage per changeset whose root conversation is its history, or a session document family keyed by changeset in a shared storage." Step 3 or step 7 picks one. Per-changeset storage matches the per-changeset subdirectories in "State storage".

**Mapping table, webhook row.** Add: "`requestId` is scoped to one conversation, so the changeset's conversation is resolved before deduplication."

**Mapping table, lens row.** From "A child conversation via the subagent pattern, configured with `configure()`" to: "A child conversation owned by the lens task, created and configured with `configure()` in one commit, with its tools set explicitly. The task, not a model, decides which lenses run." Test d2 is the pattern.

**Mapping table, publication row, and pipeline step 7.** From "`api.memo()` with first-write-wins semantics" to: "`api.memo()` for intent within one publish task, plus a conversation document recording what was posted, committed with each post. Memos die with their task." Step 7's sentence "Guarded by memos keyed on revision and finding ID so a crash between posting and checkpointing cannot double-post" becomes: "Before posting, the task memoises its intent. After posting, it records the comment in the findings document. On a rerun with intent but no record, it looks for Melian's marker on GitHub before posting again, because GitHub reviews take no idempotency key." Step 8, knowledge, takes the same guard.

**Mapping table, storage row, and "State storage".** From "The `Storage` interface: one atomic `commit(writes)` plus reads" to: "The `Storage` interface: one atomic `commit(writes)`, ID minting, thirteen reads, and `close()`. One process owns a storage at a time; Pi does no cross-process locking." The orphan-branch backend should wrap Pi's JSONL storage rather than implement the interface, and run Pi's `registerStorageConformance` suite. The Actions host serialises runs per changeset, because `--force-with-lease` detects a concurrent writer but cannot merge one into a harness already open.

**Pipeline section, opening paragraph.** Add: "A phase reruns from its start after a crash, so work before its checkpoint is safe to repeat or memo-guarded."
