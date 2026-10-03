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

Each ID holds sightings and one lifecycle record. A sighting is what one producer, a lens's name and version, reported at one head: the finding without its status. Sightings are keyed by head, then producer, and only the same producer at the same head ever replaces one. The lifecycle record is Melian's: `status`, `dismissedBy`, `dismissedReason`, `dismissedAt`, `firstSeenRevision`, `lastSeenRevision`, and a `history` of reopened dismissals. Problem: a lens reports the same finding again on every revision, and an upsert that replaced the whole finding would reset it to `new`. Example: an author dismisses `eval(input)` as safe because the input is a constant; the next push reruns the security lens, which reports it again, and the dismissal vanishes. Solution: a producer only ever writes its own sighting.

Problem: one producer record per ID raced. Example: the correctness and contracts lenses both declare `null-dereference` and report one ID at one head; the second either replaced the first's severity and source, or, as a first fix did, was refused. A review of an older head that crashed and resumed after the next push wrote over the record the newer head read. Solution: immutable sightings per head, producer, and ID, merged on read.

- The document belongs to the changeset's root conversation, never to a lens's child conversation. Problem: a lens conversation ends with its task, and a fork of the root taken to rerun a revision would not carry a document kept in a child, so the next revision would see every finding as new. Solution: `upsertFinding`, `dismissFinding`, and `readFindings` take the root conversation's ID, and step 5's `report_finding` tool is constructed with that ID and writes through it, whichever conversation calls it.
- Write findings only through `upsertFinding(tx, rootConversationId, finding, revision)`. It validates with core's `parseFinding`, replaces the sighting of `properties.source` at `revision`, and keeps the lifecycle record. The lifecycle starts as `new` when the ID is first seen.
- The document lists the heads reviewed, oldest first. `reviewChangeset` calls `recordRevision` in the commit that creates its lens task, and `upsertFinding` appends a head it has not seen. `lastSeenRevision` moves to `revision` only when `revision` is not older than it, so a resumed review of an old head cannot move it back. A dismissed finding stays dismissed unless a sighting at the last-seen head or a newer one has a trigger whose code changed materially, which for now means its normalised `trigger.snippet` differs from the merged finding's at the last-seen head; then its status becomes `new` and the dismissal moves to `history`. A moved or reindented trigger is not material. An invalid finding throws `FindingError` and aborts the whole transaction.
- A replayed or retried `upsertFinding` writes the same state again, so a tool that calls it is an idempotent upsert and can be marked `replay: "safe"`.
- Dismiss with `dismissFinding(tx, rootConversationId, id, { by, reason, at })`. The caller supplies `at`, so a replay writes the same timestamp. An unknown ID throws `FindingError` `unknownFinding`.
- Read with `readFindings(reader, rootConversationId, head, context)`, which merges the sightings at `head` into one core `Finding` per ID with the lifecycle's status, in ID order, and treats an absent document as empty. The highest severity wins, a tie goes to the producer whose check, then version, sorts first, and `properties.reportedBy` lists every producer that sighted the ID. The winner takes core's `strongestCause` of the sightings, so an evidenced `P1` beside a `P0` without evidence reads as an `affected` `P0`, which blocks, not a `pre-existing` one. A finding with no sighting at `head` is not returned, even if an earlier head reported it. Pass `{ producers }` to merge only those producers' sightings; `reviewChangeset` passes the lenses and versions it ran. Problem: the document keeps every sighting at a head, so a lens that configuration later disabled, or retiered to a new version, left its findings in every later review of that head. Solution: a review returns only what its own lenses reported. It returns deep copies typed `readonly Finding[]`: `snapshot()` hands back the harness's cached document, so a caller that changed a returned finding would change what every later reader sees without a commit.
- The functions take and return core's types. The document token stays inside the package. `upsertFinding` takes Pi's transaction, so its callers, such as step 5's `report_finding` tool, live in the pipeline.

## Credentials

`createReviewModels()` builds the models a review runs on, as a `ReviewModels` handle from `src/models.ts`. The handle is opaque: it wraps pi-ai's collection, which only the pipeline unwraps with `modelsOf`, so `ReviewOptions`, `openReviewHarness`, and the evals API name no Pi type. The testing entry's `createFakeModels()` returns the same handle as `review`, beside the raw collection a test passes to `openHarness`. The collection holds every built-in provider, resolving credentials as pi-ai does, a stored credential first and the provider's environment variables second. The store is `piCredentialStore()`, which reads Pi's `auth.json`, the file `pi` writes on `/login`: `$PI_CODING_AGENT_DIR/auth.json`, or `~/.pi/agent/auth.json`. One `pi` login covers Melian.

The store is read-only, and that has two consequences that read like bugs:

- An OAuth login that has expired, or expires within seven minutes, reads as absent, so the provider's environment variable or the tier's next model applies, and a refresh pi-ai attempts anyway fails with "run pi to refresh". Seven minutes is pi-ai's refresh window, five minutes (`DEFAULT_OAUTH_MINIMUM_VALIDITY_MS` in its `auth/resolve.js`), plus two of margin: a token selected four minutes before expiry is refreshed by pi-ai before its first request, and that refresh is a write. Recheck the window when upgrading pi-ai. pi-ai refreshes a token by writing it back through the store, and providers such as Anthropic rotate the refresh token on every refresh. A Melian that refreshed in memory without writing would leave Pi holding a dead refresh token. Expiry is checked in the store because pi-ai's `checkAuth` ignores it, and model selection relies on `checkAuth`.
- A malformed `auth.json` is a `PiCredentialsError` with no cause: V8's JSON `SyntaxError` quotes the text around the fault, which can be part of a key.
- A key Pi resolves at use, `!command` or one containing `$VAR`, reads as absent, so the provider's environment variable applies. Melian runs no commands from a credential file.

Anthropic resolves in pi-ai's order, with one alias Melian adds:

1. Pi's store.
2. `ANTHROPIC_AUTH_TOKEN`, sent as a bearer token.
3. `ANTHROPIC_OAUTH_TOKEN`.
4. `CLAUDE_CODE_OAUTH_TOKEN`, the name Claude Code keeps the same kind of token under. Melian reads it only when `ANTHROPIC_OAUTH_TOKEN` is unset, and pi-ai still labels the source `ANTHROPIC_OAUTH_TOKEN`.
5. `ANTHROPIC_API_KEY`.
6. Workload identity federation.

Melian never logs or reports a credential's value; errors name the file and the provider only.

There is no credential pool yet; one credential per provider.

## Reviewing a changeset

`reviewChangeset({ harness, changeset, config, lenses, standards, models, policy, tier, checks })` runs the lens step, then adjudication, and returns a `Review`: the root conversation's findings at the head and the `Verdict`. The harness must hold `lensExtension`, which carries both tasks; open it with `openReviewHarness`, or install the extension in your own registry. Without it a task would sit blocked forever, so `reviewChangeset` checks `harness.inspect()` after creating each task and throws `ReviewError` `notInstalled`.

1. `selectLenses` picks the lenses the changed paths and configuration call for, and the changed files each covers. No model is asked.
2. Each lens's tier resolves through `resolveModelForTier` to its route: the model and fallbacks the collection knows and holds credentials for, in order. A tier with none is `ReviewError` `noAvailableModel`.
3. One root commit creates the lens task, whose input carries the revision under review: the repository, base, head, and changed files. The same commit records the task in the root's `ReviewIndex` document under the head, with the selected lenses by `name@version`. Problem: `harness.resume()` restarts a crashed review's task, and a second call created another, so after a crash every lens ran twice. Solution: `reviewChangeset` looks the head up first, inside that commit, and when the same lenses reviewed it, it waits for that task, running, crashed, or finished, instead of creating one. A different selection, such as a disabled or retiered lens, starts a new task and replaces the entry. `test/review-crash.test.ts` kills a review in each lens's first model request, calls `reviewChangeset` again, and expects exactly one more request per lens. A task that ended without deciding anything, `aborted`, `faulted`, or `orphaned`, is not attached to: the commit reads the task's record and replaces the entry with a new task. Problem: an aborted lens task stayed in the index, so every later review of the head attached to it and failed the same way. When `reviewChangeset` aborts a task no extension defines, it also removes the task from the index. The adjudication task follows both rules.

A failed task is a decision, but not always a lasting one. Problem: a repeat call with the same input attached to an adjudication task that had ended `failed`, so a policy that could not be read once, such as a base commit a shallow clone had not fetched yet, failed every later review of that head. Solution: a failed adjudication task is always replaced on the next call, because adjudication is cheap and deterministic. A lens task that left a lens failed is replaced only with `options.rerun`, because rerunning lenses costs tokens; the CLI will expose it as `--rerun`.
4. The task's first phase creates every lens conversation in one commit, configured with its model, its instructions (`renderLensInstructions`), and an explicit tool list, and records the lens's policy and that revision in its `LensDocument`. Each lens carries its own revision, never a shared record on the root: a crashed review's lens task resumes alongside the next push's, and a shared record would move the old lenses to the new head mid-review. The second phase submits the change, rendered by `renderChangePrompt` with only the files that lens covers, to each lens in parallel, with a request ID per lens so a rerun does not submit twice.
5. A lens whose model fails moves down its route. Problem: the route used to be cut to its first model before the task ran, so a provider outage failed the lens with its fallbacks unused. Solution: the route travels in the task's input. When a lens's request ends `unanswered` with `model_error` that pi-ai would retry, after Pi Durable's own retries gave up, or that names a failed authentication, the task configures the lens conversation with the next model and advances the lens's attempt index in the same commit, then submits a short hand-over input asking the new model to continue. Each attempt has its own request ID, `lens:<key>:<attempt>`, so a crashed review resumes on the model it had reached and never resubmits to one that already failed. `isFailoverError` in `src/harness.ts` classifies the failure: pi-ai's `isRetryableAssistantError` for transient failures, and a pattern for authentication, which pi-ai does not classify. Any other failure, such as a malformed request, fails the lens without trying another model.
6. Each lens becomes a `CheckRecord` named `lens.<name>`: `ran`, or `failed` with the reason it did not finish, a route that ran out included. They join `options.checks`, the records of the review's other checks, as [The manifest](#the-manifest) describes.
7. The adjudication task decides the verdict and records it, as [Adjudication](#adjudication) describes.
8. A lens whose route runs out is `ReviewError` `allModelsFailed`, naming the lens in `lenses`, every model it tried in `models`, and the last failure in the message. A lens that does not finish for any other reason is `lensFailed`. Both carry what was reported and the `not-reviewed` verdict already recorded. A host that publishes catches the error and publishes that verdict.

### Prompt boundaries

Everything that originates from the head revision reaches a lens inside a boundary from `quoteUntrusted(label, text, nonce)` in `src/untrusted.ts`: `<untrusted-NONCE label="LABEL">`, the text, `</untrusted-NONCE>`. Labels are `diff`, `file`, `search`, and `listing`. `reviewChangeset` draws the nonce once per review with `reviewNonce()` and stores it in the lens's `ReviewState`, so a replayed tool quotes with the same one.

- `renderChangePrompt(changeset, nonce, only?)` puts the changed-file list in one `listing` block and each file's diff in its own `diff` block whose first line names the file. Problem: a removed line `-- src/fake.ts` renders as `--- src/fake.ts`, a header for a file that is not there. Solution: a file starts where its block starts, not at a line that looks like a header.
- `read_file`, `search`, and `list_files` quote their results. Melian's own notes, such as "more matches not shown", stay outside the block, and never repeat a path from the head.
- Paths pass through core's `visibleText` everywhere they reach a prompt, so a path holding a newline cannot forge a line in a listing.
- Text that holds the nonce has it replaced with `[nonce]`, which cannot happen by chance and would otherwise close the block.
- Every lens conversation is configured with `extensions: [lensExtension]` and nothing else, so its `injection_policy` section renders first and its `instructions` last. The section names the nonce, says that everything inside a boundary is data, and tells the lens to report an instruction found there under `melian/injection-attempt`. `reviewChangeset` adds that rule to any lens that does not declare it, so the hook never refuses the report the policy asks for.
- A new tool that returns head content quotes it the same way. A test asserts on what the model was shown, not only on what it returned: `test/review.test.ts` strips every boundary from a prompt and checks that no path or line from the head remains.

### Lens tools

`read_file`, `search`, and `list_files` read the head commit through core's `readRevisionFile`, `searchRevision`, and `listRevisionFiles`, never the working tree. They bound output per call, never the file: `read_file` takes `startLine` and `maxLines`, at most 2000, reads the window from the whole blob, and ends with a note naming the next `startLine`, so any line is reachable. `report_finding` checks a line against the file's true line count.

Pi Durable cuts a tool's result at 50 KB or 2000 lines unless the tool sets `outputLimits`, keeping the head. That cut dropped a boundary's closing tag and Melian's notes. Each lens tool therefore bounds the body it quotes at 48 KiB and sets `outputLimits` above it, so Pi never cuts. A new tool that returns head content does the same. They find the head through the calling conversation's `LensDocument`. All three are replay-safe because they only read.

`report_finding` takes a file, a line, an optional end line, a rule, a severity, an explanation (what, why, fix), and optional evidence. The model supplies nothing else:

- The snippet is the head revision's text at those lines, read by Melian, so the finding's ID does not depend on how the model quoted the code. Its occurrence among identical snippets in the file comes from core's `snippetOccurrence`.
- Cause comes from `classifyCause`. Code inside a hunk is `introduced`; anywhere else it is `pre-existing`, unless the lens gave evidence, `{ file, line, endLine }` naming the changed lines that break it. Core's `checkEvidence` refuses evidence outside every hunk's new lines or in a file the change does not modify; accepted evidence makes the finding `affected` and is stored as its `evidence`, with the snippet read from the head. Prose evidence is refused in `prepareArguments`, before schema validation, so the model reads what evidence must be rather than a schema error.
- Source comes from the lens's name and version, and status from the document. The tool stores no resolution: only adjudication writes one, so a pre-existing P1 never arrives marked to block.

It refuses a file outside the lens's coverage, its folder and `paths` less any folder a nearer lens of its name covers. It upserts into the root conversation's findings document at the head revision, never the lens's own, so one review has one document. A trigger carries the hunk's added lines as its snippet, so a dismissal reopens only when that code changes.

### The policy hook

`lensPolicyHook` runs before every tool call in a conversation that has a `LensDocument`, and passes every other call untouched. It blocks a tool the lens did not list, a severity outside its `severities`, and a rule outside its `rules`, listing the rules that exist. The model reads the reason as the tool result and can correct itself.

The budget is checked only inside `report_finding`'s commit, never in the hook. Problem: the hook cannot tell a new finding from a correction of one the lens already reported. Example: a lens with `budget.findings: 1` reports a finding, and the process dies after the commit and before the tool result. On resume the replay-safe tool reruns, and the model, which never saw a result, calls `report_finding` again. A hook that counted committed findings refused that call at the full budget. Solution: the commit refuses only a finding the lens has not yet reported at its head, so a replay or a correction always passes. The commit also sees every finding a parallel round committed before it, which the hook, reading a snapshot, does not. `test/review-crash.test.ts` kills a review at exactly its full budget and checks both the replay and the correction.

One storage holds every review of a changeset, so the root's findings document accumulates across pushes. The budget counts only the lens's own sightings at its own head, and `reviewChangeset` returns only findings sighted at the head it reviewed. Without that, a lens that used its budget on the first push could report nothing on the second, and a fixed finding would come back as current.

A finding's ID names no lens, so two lenses that share a rule ID can report one ID. Each writes its own sighting, neither is refused, and each counts it against its own budget. The read merges them.

## Adjudication

The adjudication task, `melian.adjudication`, reads the root conversation's findings at the head under review through `readFindings` with the producers the review selected, runs core's `adjudicate`, and writes the verdict into `VerdictDocument` on the root under that head. Like the findings document, the verdict document belongs to the root, is rewindable, and forks `asOf`, so a fork of the root at a revision carries that revision's verdict. Read it with `readVerdict(reader, rootConversationId, revision, context)`, which returns a copy or `undefined`.

The task has one phase. It reads, decides, and commits the verdict and the task's terminal outcome together, so a crash before that commit reruns the phase, which reads the same findings and writes the same verdict. Everything it decides from is in its input, fixed when `reviewChangeset` creates it: the root, the repository, the head, the manifest, the check records, the skips allowed, the producers, and the configuration. The producers come from the manifest, the same list `Review.findings` is read with: each lens the review ran as `lens.<name>` at its version, so a lens that configuration has since disabled or retiered leaves its sightings at that head out of the verdict too, and every other check of the manifest by name, at the version its record names or at any version when it names none.

A repeat review of a head attaches to its adjudication task as it does to its lens task. The commit that creates the task records it in the root's `ReviewIndex` entry for the head, with its input as JSON; a later call with the same input waits for that task instead of creating one. Input that differs, such as a check record from static analysis that has since run, creates a task and records it in its place. Problem: a crashed review's adjudication task resumes when the harness does, and could commit after a newer review of the head, putting the older verdict back. Solution: the task's final commit reads the index, and a task the index does not name exactly ends `superseded` without writing; `reviewChangeset` throws `adjudicationFailed` for it. An entry naming no adjudication task counts as naming another. Problem: a review with a new lens selection replaces the head's entry before it creates its own adjudication task, and a first fix that let an entry with none through had the crashed task write in that gap. `test/review-crash.test.ts` kills a review inside adjudication, starts one with another selection, and expects the old task to write nothing.

Resolution is per path. With `options.policy`, the source `config` was loaded from, the task calls `loadConfig` for each finding's path, so a nested `melian.yaml` that lowers `P2` to `advisory` for `docs/` applies there. Without it, `config`'s `resolution` and `ruleAliases` apply everywhere. A lens stores no resolution, so `Review.findings` carry none: they are not yet adjudicated. The verdict's findings carry the resolution adjudication decided, and a host reads what blocks from the verdict, never from `Review.findings`.

### The manifest

The tier's check list is the review's manifest. `reviewChangeset` expands `options.tier`, or the tier configuration maps the `pull-request` stage to, with core's `checksOfTier`, and every check in it must produce a record by adjudication. Problem: the records of other checks were optional and defaulted to none, and the producers held only the lenses. Example: a static tool's stored `P0` sighting never reached the verdict, and a review whose Biome run never started read `passed`. Solution: a check with no record is `skipped` with the reason `no record`, so the verdict is `not-reviewed`, and the producers are derived from the manifest, so a static or guardrail check's sightings count beside the lenses'.

Only lenses the manifest names run. The lens step records each of them, and a record named `lens.*` in `options.checks` gives way to it. A lens of the manifest that did not run is recorded as:

- `failed`, `no lens is named <name>`, when no lens of that name is loaded.
- `skipped`, `lenses.<name>.enabled is false`, when configuration switches it off. That is an exclusion, and the design reports an exclusion as not reviewed unless the repository lists the check in `checks.allowSkip`.
- `skipped`, `no lens covers these paths`, when no lens of the manifest covers a changed path, so nothing reviewed the change.
- `skipped`, `no changed file is in its paths`, when another lens ran. Only this skip is allowed.

A `decisions.*` check is skipped and allowed while no decision provider is configured, as the design lets the fast tier degrade. Every check `config.checks.allowSkip` names joins the allowed skips. Any other check, such as `guardrails` or `static.biome`, records itself through `options.checks` as `{ name, status, reason?, error?, version? }`, where `version` is the tool version its findings name; without a record it is `no record`.

[Pull request #18](https://github.com/melian-agent/melian/pull/18) adds `runChecks`, which keeps one record per check of a tier in the `melian.checks` document under a run identity of base, head, tier, policy hash, and task. Its records map onto this shape one for one: `check` is `name`, `status` is unchanged, a skip's `reason` is `reason`, and a failure's `error.message` is `error` with its `error.code` as `reason`. It records `lens.*` checks as skipped, which the lens step's own records replace, and `decisions.*` as skipped, which the rule above allows while no provider is configured. One field is missing: its `ran` record carries no tool version, so either it gains `version` from the head's SARIF driver, or the record omits it and the review counts that check's sightings at every version.

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
- Script parallel conversations, such as lenses, with `scriptConversations()`, which answers each request from the script whose `match` appears in its system prompt. A plain response queue would hand the replies out in whatever order the harness calls the model.
- Open review harnesses with `settings: { retry: { enabled: false } }` in tests, so a scripted error reply fails the lens at once instead of retrying with backoff.
- Use memory storage unless the test is about surviving a reopen or a crash. Then use SQLite in a temporary directory and delete it afterwards.
- Close every harness in `afterEach`, before deleting its directory, so a failed assertion does not leave a live SQLite handle. `close()` is idempotent.
- Test a crash with a real process kill. Run the first half in `test/fixtures/crash.ts`, have it append events to a log synchronously, SIGKILL it at a known event, and resume in the test process against the same file. Count reruns from the log.
- The parent polls that log while the child writes it, so ignore text after the last newline: it is an event still being written. Detect an early death through `signalCode` as well as `exitCode`, which stays null when a signal kills the child, and kill the child in a `finally`.
- A fake reply carrying tool calls needs `stopReason: "toolUse"`; the default `"stop"` ends the run without running them.
- Assert on what the model was shown, not only on what the harness returned. `captured()` in `test/fixtures/spike.ts` keeps each request's messages.
