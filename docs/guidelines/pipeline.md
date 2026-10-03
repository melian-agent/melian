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

## Credentials

`createReviewModels()` builds the pi-ai model collection a review runs on: every built-in provider, resolving credentials as pi-ai does, a stored credential first and the provider's environment variables second. The store is `piCredentialStore()`, which reads Pi's `auth.json`, the file `pi` writes on `/login`: `$PI_CODING_AGENT_DIR/auth.json`, or `~/.pi/agent/auth.json`. One `pi` login covers Melian.

The store is read-only, and that has two consequences that read like bugs:

- An OAuth login that has expired, or expires within seven minutes, reads as absent, so the provider's environment variable or the tier's next model applies, and a refresh pi-ai attempts anyway fails with "run pi to refresh". Seven minutes is pi-ai's refresh window, five minutes (`DEFAULT_OAUTH_MINIMUM_VALIDITY_MS` in its `auth/resolve.js`), plus two of margin: a token selected four minutes before expiry is refreshed by pi-ai before its first request, and that refresh is a write. Recheck the window when upgrading pi-ai. pi-ai refreshes a token by writing it back through the store, and providers such as Anthropic rotate the refresh token on every refresh. A Melian that refreshed in memory without writing would leave Pi holding a dead refresh token. Expiry is checked in the store because pi-ai's `checkAuth` ignores it, and model selection relies on `checkAuth`.
- A malformed `auth.json` is a `PiCredentialsError` with no cause: V8's JSON `SyntaxError` quotes the text around the fault, which can be part of a key.
- A key Pi resolves at use, `!command` or one containing `$VAR`, reads as absent, so the provider's environment variable applies. Melian runs no commands from a credential file.

There is no credential pool yet; one credential per provider.

## Reviewing a changeset

`reviewChangeset({ harness, changeset, config, lenses, standards, models, policy, checks })` runs the lens step, then adjudication, and returns a `Review`: the root conversation's findings at the head and the `Verdict`. The harness must hold `lensExtension`, which carries both tasks; open it with `openReviewHarness`, or install the extension in your own registry. Without it a task would sit blocked forever, so `reviewChangeset` checks `harness.inspect()` after creating each task and throws `ReviewError` `notInstalled`.

1. `selectLenses` picks the lenses the changed paths and configuration call for, and the changed files each covers. No model is asked.
2. Each lens's tier resolves through `resolveModelForTier` to the first model the collection knows and holds credentials for.
3. One root commit creates the lens task, whose input carries the revision under review: the repository, base, head, changed files, and resolution.
4. The task's first phase creates every lens conversation in one commit, configured with its model, its instructions (`renderLensInstructions`), and an explicit tool list, and records the lens's policy and that revision in its `LensDocument`. Each lens carries its own revision, never a shared record on the root: a crashed review's lens task resumes alongside the next push's, and a shared record would move the old lenses to the new head mid-review. The second phase submits the change, rendered by `renderChangePrompt` with only the files that lens covers, to each lens in parallel, with a request ID per lens so a rerun does not submit twice.
5. Each lens becomes a `CheckRecord` named `lens.<name>`: `ran`, or `failed` with the reason it did not finish. They join `options.checks`, the records of the review's other checks.
6. The adjudication task decides the verdict and records it, as [Adjudication](#adjudication) describes.
7. A lens that did not finish is still a `ReviewError` `lensFailed` naming it, carrying what was reported and the `not-reviewed` verdict already recorded. A host that publishes catches it and publishes that verdict.

### Lens tools

`read_file`, `search`, and `list_files` read the head commit through core's `readRevisionFile`, `searchRevision`, and `listRevisionFiles`, never the working tree. They find the head through the calling conversation's `LensDocument`. All three are replay-safe because they only read.

`report_finding` takes a file, a line, an optional end line, a rule, a severity, an explanation (what, why, fix), and optional evidence. The model supplies nothing else:

- The snippet is the head revision's text at those lines, read by Melian, so the finding's ID does not depend on how the model quoted the code. Its occurrence among identical snippets in the file comes from core's `snippetOccurrence`.
- Cause comes from `classifyCause`. Code inside a hunk is `introduced`; anywhere else it is `pre-existing`, unless the lens gave evidence, the changed line that breaks it, which makes it `affected` and is stored as the finding's `evidence`.
- Resolution comes from the configuration, source from the lens's name and version, and status from the document.

It refuses a file outside the lens's coverage, its folder and `paths` less any folder a nearer lens of its name covers. It upserts into the root conversation's findings document at the head revision, never the lens's own, so one review has one document. A trigger carries the hunk's added lines as its snippet, so a dismissal reopens only when that code changes.

### The policy hook

`lensPolicyHook` runs before every tool call in a conversation that has a `LensDocument`, and passes every other call untouched. It blocks a tool the lens did not list, a severity outside its `severities`, and a rule outside its `rules`, listing the rules that exist. The model reads the reason as the tool result and can correct itself.

The budget is checked only inside `report_finding`'s commit, never in the hook. Problem: the hook cannot tell a new finding from a correction of one the lens already reported. Example: a lens with `budget.findings: 1` reports a finding, and the process dies after the commit and before the tool result. On resume the replay-safe tool reruns, and the model, which never saw a result, calls `report_finding` again. A hook that counted committed findings refused that call at the full budget. Solution: the commit refuses only a finding the lens has not yet reported at its head, so a replay or a correction always passes. The commit also sees every finding a parallel round committed before it, which the hook, reading a snapshot, does not. `test/review-crash.test.ts` kills a review at exactly its full budget and checks both the replay and the correction.

One storage holds every review of a changeset, so the root's findings document accumulates across pushes. The budget counts only findings the lens reported at its own head, and `reviewChangeset` returns only findings reported at the head it reviewed. Without that, a lens that used its budget on the first push could report nothing on the second, and a fixed finding would come back as current.

A finding's ID names no lens, so two lenses that share a rule ID can report one ID. The first lens to report it at a head keeps it; `report_finding` refuses the second, which would otherwise replace the first lens's severity and source and free a slot in the first lens's budget. Merging the two is adjudication's job.

## Adjudication

The adjudication task, `melian.adjudication`, reads the root conversation's findings at the head under review, runs core's `adjudicate`, and writes the verdict into `VerdictDocument` on the root under that head. Like the findings document, the verdict document belongs to the root, is rewindable, and forks `asOf`, so a fork of the root at a revision carries that revision's verdict. Read it with `readVerdict(reader, rootConversationId, revision, context)`, which returns a copy or `undefined`.

The task has one phase. It reads, decides, and commits the verdict and the task's terminal outcome together, so a crash before that commit reruns the phase, which reads the same findings and writes the same verdict; a second review of the same head replaces the verdict with the new one. Everything it decides from is in its input, fixed when `reviewChangeset` creates it: the root, the repository, the head, the check records, and the configuration.

Resolution is per path. With `options.policy`, the source `config` was loaded from, the task calls `loadConfig` for each finding's path, so a nested `melian.yaml` that lowers `P2` to `advisory` for `docs/` applies there. Without it, `config`'s `resolution` and `ruleAliases` apply everywhere. The resolution a lens stored at report time came from `config`; the verdict's is the one that counts, and `Review.findings` keeps the stored one.

Check records are the seam with static analysis and guardrails, step 6. A step that runs a check passes `{ name, status, reason?, error? }` in `options.checks`; nothing else about its records matters to adjudication. A check that failed or was skipped makes the verdict `not-reviewed`, so a host must record every check the tier called for, including the ones that never started.


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
- Script parallel conversations, such as lenses, with `scriptConversations()`, which answers each request from the script whose `match` appears in its system prompt. A plain response queue would hand the replies out in whatever order the harness calls the model.
- Open review harnesses with `settings: { retry: { enabled: false } }` in tests, so a scripted error reply fails the lens at once instead of retrying with backoff.
- Use memory storage unless the test is about surviving a reopen or a crash. Then use SQLite in a temporary directory and delete it afterwards.
- Close every harness in `afterEach`, before deleting its directory, so a failed assertion does not leave a live SQLite handle. `close()` is idempotent.
- Test a crash with a real process kill. Run the first half in `test/fixtures/crash.ts`, have it append events to a log synchronously, SIGKILL it at a known event, and resume in the test process against the same file. Count reruns from the log.
- The parent polls that log while the child writes it, so ignore text after the last newline: it is an event still being written. Detect an early death through `signalCode` as well as `exitCode`, which stays null when a signal kills the child, and kill the child in a `finally`.
- A fake reply carrying tool calls needs `stopReason: "toolUse"`; the default `"stop"` ends the run without running them.
- Assert on what the model was shown, not only on what the harness returned. `captured()` in `test/fixtures/spike.ts` keeps each request's messages.
