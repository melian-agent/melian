# Stage telemetry

Status: proposed; phase 1 of milestone 2, step 31. Implementation waits for an attacking review and the coordinator's go-ahead.

## Problem

A review records its findings and model spend, but no stage duration. A slow round gives the maintainer no way to choose what to improve.

## Example

A 240-line review took 64 minutes. On [pull request #131](https://github.com/melian-agent/melian/pull/131), the mutation check repeated the whole suite after NoCoverage. Its notes explain the repeat, but no timing shows how much of the round it took. Lens and verifier time are unknown too.

## Solution

Use Pi's span contract for instrumentation and keep a durable projection in Melian's changeset storage. Every host uses the pipeline's instrumentation. Reading telemetry never starts a review, resumes a task, or calls a model.

### The installed authority

The installed `@earendil-works/pi-telemetry` is version 1.0.0. Its README and `dist/index.d.ts`, `memory.d.ts` and `noop.d.ts` define these contracts:

- `TelemetryContext.startSpan(options, callback)` invokes the callback once and settles its span when the callback settles. A span has no public end method.
- `TelemetrySpan` is an explicit parent context. Recording attributes, events and status is synchronous, passive and non-throwing.
- `defineTelemetrySchema` and `createTypedSpanStarter` type a package's span names, attributes and events. They perform no runtime validation.
- `SpanStatus` is `ok` or `error`. A normal return defaults to `ok`; expected failures returned as data need an explicit error status.
- `InMemoryTelemetryContext` records detached span snapshots, with IDs, parents, attributes, events, status and settlement. It records no timestamps and persists nothing.

Pi Durable 1.0.0 has no `TelemetryContext` option and emits no task or model-request spans. Its `HarnessOptions` supplies a host clock through `now`. `UsageDoc` durably records model spend per conversation. Searching its installed declarations and JavaScript finds no telemetry integration. pi-agent-core's schemas do not instrument Pi Durable.

Melian defines its stage schema through Pi's helpers. The pipeline owns it and pins pi-telemetry as a direct dependency when implementing. Core takes plain JSON projections and imports no telemetry runtime. A future Pi Durable integration can add child spans without changing this durable contract.

### Span vocabulary

The schema has version 1. Every stage has revision and owner attributes. Subject attributes distinguish check names, lens versions and levels, and candidate IDs.

| Span name | Starts | Ends |
| --- | --- | --- |
| `melian.triage` | Before the decision task asks its decider | With its recorded answer, failure or supersession |
| `melian.check` | Before one deterministic check starts | With that check's findings, record and terminal outcome |
| `melian.lens` | Before one lens run submits its first request | With that run's outcome, before any escalation starts |
| `melian.verification` | Before verification admits candidates | With the task's aggregate result |
| `melian.verification.candidate` | When the candidate starts work, after its concurrency wait | With that candidate's final outcome |
| `melian.adjudication` | Before adjudication reads and resolves findings | With the verdict and terminal outcome |
| `melian.walkthrough` | Before the summariser task creates its conversation | With its stored summary or fixed failure note |
| `melian.publication` | Before a validated publish task performs provider work | With its terminal publication outcome |

Each deterministic check gets its own span: guardrails, Biome, tsc, Enola and mutation when the manifest names them. A static check includes both revisions, setup, cleanup and any fallback. Its existing notes retain the mutation selection and fallback reasons. Timing internal Stryker subprocesses separately is outside this step.

A lens subject is its existing run key, including version and level. Quick and escalated runs are siblings with separate intervals. Provider failover continues that level's interval and records the models it used. Each candidate is a child of the verification total. Other stages are siblings in the review projection. Their sum is never presented as elapsed review time: checks, lenses and candidates overlap.

Start attributes include `melian.revision` and `melian.owner`. Subjects use `melian.check`, `melian.lens`, `melian.level` and `melian.candidate`. Completion records `melian.outcome`: `completed`, `failed`, `skipped`, `ended`, `provisional`, `aborted` or `superseded`. These describe execution, not whether findings block. Checks with findings can complete successfully. Returned failures and budget endings explicitly set Pi's error status. Skips and provisional results retain their outcome without becoming execution errors.

A stage that does no work leaves an explicit decision record with outcome `skipped`, a fixed reason and a zero-length interval. Examples are triage without questions, verification without candidates, a range's walkthrough and publication not requested by review. A manifest lens skipped by policy gets a skip record. Checks or lenses absent from the manifest need no span. Existing manifest rules still decide whether a skip is allowed.

### Durable projection

Add a root conversation document, kind `melian.telemetry`, version 1, with rewindable history and an as-of fork:

```ts
type TelemetryState = {
  nextSpan: number;
  nextReview: number;
  spans: Record<string, StoredStageSpan>;
  reviews: ReviewObservation[];
};
```

A source key is `task:<id>` plus stage name and subject. Lenses and candidates use their existing run keys. Decision-only skips with no task use `review:<observation-id>` instead. IDs are scoped to this changeset's storage. New tasks created by rerun get new keys. No telemetry field participates in task attachment, finding identity, adjudication identity or publication fingerprints.

`StoredStageSpan` projects Pi's recorded span fields: numeric `id`, `parentId`, `name`, primitive `attributes`, ordered `events`, `status` and `settled`. It adds `startedAt`, optional `endedAt` and optional `durationMs`, in epoch milliseconds and milliseconds respectively. These are Melian's timing fields; Pi's recorder supplies none. An unfinished span has no final duration or outcome. `melian.outcome` is a completion attribute. Optional `usage` holds the existing `{ models, tokens, cost }` projection, with cost in USD.

A review observation has a durable increasing `id`, its `revision`, a `settled` flag, and `stages`, references of `{ spanId, reused }`. Admit it before work. Settle it when the call finishes, including optional summarisation or a reported error. A later call creates another observation; a call that dies leaves its observation unfinished, even if all its recorded stages have since completed. A resumed call references the same source stages rather than restarting their clocks. `reused` is true only when the source stage had finished before this observation attached. Attaching to pending work resumes it. Earlier observations remain stored.

An observation is diagnostic identity, not a new definition of a review round. It uses the checks, decision, lens and adjudication owners the existing indexes select. The CLI admits it before its separate `runChecks` call and passes its handle through review and summarisation. Library `reviewChangeset` admits one when the host has not. Supplied check records can name their original check run; otherwise their timing is explicitly unavailable. An unavailable stage entry names the stage, subject and reason, with `timing: "unavailable"` instead of a span reference. It has no invented interval. This also represents legacy work with no committed start.

Publication runs later. At task creation, select the latest observation whose adjudication reference names the exact decided task being published. Store that link with task creation in the telemetry document. Replay keeps it even if another observation has since attached. Append the publication stage there, replacing that observation's not-requested placeholder. Earlier publication spans remain when publication is retried. A repeat publish that performs reconciliation has its own interval, even when it posts nothing. Another decision or revision cannot acquire that publication.

### Crash, replay and host clocks

Record wall time across a crash, rather than a sum of attempts. A stage interrupted for ten minutes includes those ten minutes. It measures time until the result became durable, not CPU time or provider billing time.

Commit the first start before stage work, keyed by its durable owner. Replay reads that value and cannot replace it. Finish the projection in the same commit as the stage's result or terminal outcome. Capture host time as data for that commit and retain the first stored finish. Replaying a completed stage never samples a new clock or adds its duration again. Completed quick runs and checks remain available even when the process dies before adjudication records a verdict.

For a multi-phase lens or verification task, checkpoint each run's finish when it completes. Do not wait for siblings or adjudication. A candidate verdict report is not its finish: the candidate can still make requests afterwards. Abort and supersession handlers settle a started span once. A replaced task writes only its own source span. The new observation selects its new owner; old work cannot overwrite another span or the current verdict.

Durable writes belong to the task's normal commits, inside Pi's span callback. Do not implement asynchronous storage in `setAttributes`, `setStatus` or an exporter. Pi requires those calls to be passive and non-throwing. Contexts and live spans stay in memory; only plain projection data enters storage. On resume a fresh process-local span covers resumed work, while the durable projection keeps the logical stage's first start.

Persist `endedAt` as the host observed it and `durationMs = Math.max(0, endedAt - startedAt)`. If the clock moved backwards, record a typed `melian.clock_regressed` event. This preserves the timestamps and a non-negative duration without claiming monotonic host time.

Older tasks with no committed start show timing unavailable. Never derive a duration from the current time or a Pi sequence number. A changed stored task input, checkpoint, outcome or existing document needs its own version bump, a fixture written by the preceding version, and a reopen test.

### Spend and privacy

Read spend from Pi's durable `UsageDoc`, never from elapsed time or model prices. Preserve each lens level's conversation usage, including failed requests for which Pi retained usage. Verification totals aggregate distinct candidate conversations once. Reused stages keep original usage and are excluded from newly incurred spend. A parent total is not added to its children again.

An unavailable usage record stays absent; zero is a measured zero. Add no model calls for telemetry. Store no prompts, completions, file contents, tool payloads, credentials or provider diagnostics in attributes. Use fixed outcome codes and the existing stage records for detailed reasons.

### CLI and terminal output

`melian review --json` prints the existing verdict fields plus `telemetry`, the selected observation expanded with its source spans and reuse flags. The verdict stays unchanged, so telemetry cannot trigger another publication. JSON stays parseable. Plan warnings and timing diagnostics use standard error.

After durable admission, an error before a verdict prints an `error` object and the partial `telemetry` record. A failure before storage can open has no record and prints `telemetry: null`. Neither case invents a verdict. The command keeps its existing failure exit code.

Print one standard-error line per review, naming up to three slowest completed stage intervals. Sort by descending duration, then stable name and subject order. Include lens level or candidate ID where needed and mark reused stages. Exclude skipped placeholders and unfinished stages. With none timed, say telemetry is unavailable. Do not sum overlapping intervals.

`melian telemetry <range|#pr> [--json]` reads local refs and storage with the same target rules as findings. It prints all observations for the selected base and head, including unfinished ones and later publication. Text lists start, end, duration, outcome, reuse and available spend. JSON has a `reviews` array of expanded observations, without rounding. It opens no harness scheduler, fetches nothing and unlocks no credentials. Exit 0 means records printed; exit 1 means absent telemetry or unreadable storage; exit 64 means invalid arguments.

Older reviews remain readable and publishable without telemetry. The command reports its absence. The ledger can project available timing into its run details. No telemetry write changes policy, verdict or published status.

### Proof and delivery

Phase 1 adds failing tests through current entry points. They exercise every stage, a real process kill during escalation, completed-task attachment, and review JSON. Failure must be absent telemetry, not an import or command error. The full gate is expected to be red on these tests until phase 2.

Phase 2 starts after the coordinator accepts the attacking review. Add the schema, recording and CLI with the least code. Inventory every changed guard, branch, bound and early return. Also prove skips, failures, clock regression, supersession, partial check reruns, old-record reopening, terminal ranking and detached reads. Run each mutation, the mutation check on implementation commits, and the whole gate. Record the results in a new progress-log entry.
