# Capture the reasoning setting of each request

Status: accepted for milestone 2, step 32.

Supersedes: [2026-10-18-token-telemetry-incomplete-requests.md](2026-10-18-token-telemetry-incomplete-requests.md).

The timing and counter contract is restated below. Request capture changes its usage storage and observation rules. It changes no reasoning level.

## Problem

Reasoning tokens do not say which reasoning setting produced them. The same requested level can produce different provider settings.

At Pi Durable and pi-ai 1.1.0, Pi defaults to `thinkingLevel: "off"` and omits the simple stream's reasoning option. The Codex adapter sends Terra `reasoning.effort: "none"`. Sol's catalogue maps off to null, so its body omits reasoning. Sonnet 5.5 and Opus 5.5 use adaptive thinking with high effort under `supportsMidConvoEffort`. Their assistant messages carry `providerThinkingLevel`.

The builder checked the installed agent, generation, compaction and provider implementations and the four catalogue entries. These are observations about this dependency version, not Melian's reasoning policy.

## Decision

Capture settings without choosing a level. Keep the requested level, observed sent settings and any `providerThinkingLevel` separate. A body with no reasoning setting says `provider default`. A provider that does not invoke the payload callback gets `derived, not observed`, with only its catalogue mapping where present. Missing mappings remain unavailable. Older records gain no invented level.

Pi's JSON-only `ConversationStreamOptions` excludes callbacks. Generation hooks expose messages, and compaction hooks cannot observe every request. The public host-supplied `Models` port does carry pi-ai's `onPayload`. Decorate that port in `ReviewHarness` for generation and compaction. Observe the payload after any existing callback, and preserve that callback's replacement. Do not change the payload, model options or response.

Read only reasoning settings. Store their request paths, including nested Google and Bedrock settings, rather than whole request bodies. Exclude messages, instructions, credentials and unrelated output schemas. Store each callback's snapshot, since one logical request can expose several payloads. An adapter's internal attempts without callbacks or separate response usage remain outside this evidence.

Pi's missing simple reasoning option means requested `off`; Pi pins that level before dispatch. A direct `RouteTextModel` completion specifies no level, so its requested value is `unspecified`. That adapter forwards capture through the usage observer before validating the answer. Failed or malformed replies keep their reported usage and reasoning.

## Storage and settlement

Increase `melian.model-usage` to version 2. Keep its existing task-keyed triage summaries. Add request receipts to the same family, one member per conversation under `conversation:<id>`. A receipt contains the response's actual model identity, usage and reasoning capture. The conversation ID in the key prevents a fork from treating inherited receipts as its own. No Pi document or task version changes. Strip explicitly undefined optional fields before committing strict JSON; retain reported zeroes and null catalogue mappings.

Await the receipt commit before returning the response through the models port. Repeated reads of one stream result share one receipt. A generation, tool continuation, failover or compaction response gets its own receipt. Triage still commits its observer's receipts with its decision or failure.

Pi's UsageDoc remains the authority for conversation totals. The reader adds request receipts beside those totals. Capture cannot join Pi's result transaction through this port. A crash can therefore preserve a receipt before Pi settles its response. Its own reported usage remains visible, while aggregate counters still describe Pi's settled usage. Requests lost before a response or capture commit remain unavailable; nothing estimates billing.

This extends the [token telemetry contract](2026-10-18-token-telemetry-incomplete-requests.md). Its timing, selection, incomplete-count, detached-read, aggregation and identity rules remain unchanged. Timing still stores nothing per call. Usage now retains an array per returned request because a model's settings can differ between requests. There is no document per request.

## Output and proof

Telemetry text and JSON, review JSON, terminal model summaries and each live golden's spend retain the settings. Terminal output escapes provider and model text. Attachments reuse the stored receipts.

Fake providers record the body they received. Tests compare capture with that body for lenses, verification, triage, walkthroughs, compaction and failover. They cover omitted reasoning, distinct requested and sent levels, callback replacements, pagination and old-version reopening. The version-1 fixture was recorded through main's decision task at `a96c5447`.

Pi could make capture atomic with settlement by accepting a host payload observer and invoking a receipt writer in both generation's and compaction's usage commits. That would remove this port's separate capture commit. It is an upstream improvement, not a reason to infer what a payload hook already observes.

## Retained timing and counter contract

The coordinator's ruling in [pull request #146](https://github.com/melian-agent/melian/pull/146) still requires known lost usage to be marked incomplete. The earlier timing contract follows [pull request #135](https://github.com/melian-agent/melian/pull/135)'s attacking review.

### Problem

A review records findings and spend, but no stage duration. A 240-line round took 64 minutes. On [pull request #131](https://github.com/melian-agent/melian/pull/131), mutation testing repeated the whole suite after NoCoverage. Nothing showed how much of the round it took.

### Model-call audit

Audit of the builder's starting head, e0a9d00f5ecd4bb25a642c815f921479bb4370c1, on 2026-10-18. The source search covers every complete, stream, submit, answer and decide call under pipeline, decisions, evals and CLI source.

| Entry and call path | Usage reaching stage telemetry before this change |
| --- | --- |
| Review triage: decisionTask → Decider.decide | No. The stage has timing only. RecordedDecider asks no model; a custom adapter must report any model usage. |
| LLM fallback: FallbackDecider.decide → RouteTextModel.answer → Models.complete | No conversation and no durable usage record. Successful, malformed, prose, error and aborted replies all lose their reported usage. The cheapest credentialed model is selected once; this adapter performs no provider failover. |
| LensTask review → child.submit, including later tool turns | Yes, through that child's UsageDoc. The projection keeps model names, totalTokens and cost.total, but drops token kinds and per-model spend. |
| Quick-to-careful escalation → spawnLens and the same run helper | Yes. Each level has its own child and usage ledger. Its parent task owns both; telemetry selects both. |
| Lens provider failover → configure the same child and submit the next attempt | Yes. UsageDoc keeps all assistant responses by actual provider/model, including failed attempts, rather than just the final configured model. |
| VerificationTask verify → candidate child.submit and failover | Yes, with the same projection loss. Each candidate owns a child. Every route attempt stays in that child. |
| SummaryTask summarize → child.submit for the walkthrough | Yes, with the same projection loss. The review command requests it; publishing uses a stored walkthrough. |
| Pi conversation compaction → CompactionTask → Models.completeSimple | Yes. Pi adds every returned compaction attempt's usage to that conversation's UsageDoc in its response commit, although it appends no assistant entry. Reconstructing usage from transcript entries would miss it. |
| Pi generation retries and tool continuations | Yes. Pi's generation appendAssistant records each returned assistant message and its usage in one commit. Its retry and error paths use that writer. Provider-internal attempts for which Pi exposes no response usage cannot be measured. |
| Dismissal: DismissalHarness → recordDismissal → AdjudicationTask | No model call. The harness installs adjudication alone. An interrupted lens cannot resume there. |
| Publication: PublishHarness → PublishTask | No model call. The CLI opens it with idle models and the publish extension alone. Publication renders stored data and sends provider requests, which are GitHub calls. |
| Lens live eval: runGolden → reviewChangeset | Conversation usage exists as above, but the eval closes its in-memory store without returning telemetry. Its score line prints no spend. |
| Verifier live eval: runVerifierGolden → fake finder plus real verifier | Conversation usage exists, but is discarded at close and absent from the score line. The planted fake finder has its own model identity. |
| Triage live eval: runTriageGolden → FallbackDecider on the chosen live model, with fake lenses | Decider usage is absent; fake lens usage exists. The result keeps choices alone. Each pass owns a separate store. |
| Scripted evals, including runVerifierScenario | Use the same pipeline paths with fake models. Resolution goldens ask no model. Credential discovery, doctor, comparison and detached telemetry ask no model. |

Only RouteTextModel calls a model outside Pi conversations. FallbackDecider is TextModel's sole production caller. DecisionTask is Decider's sole orchestration caller. The audit found no other model request.

### Decision

Ask Pi for the facts it already stores. Derive lens, verifier-candidate and walkthrough intervals from their durable transcripts at read time. Add no timing records to those tasks. Request capture uses the usage family. Each deterministic stage stores its first start through `runtime.memo("telemetry.start", runtime.now())`. Its own terminal commit copies that start and an end from `runtime.now()` into its own `melian.stage-timing` document-family member, keyed by task ID. Triage, each check, adjudication and publication use this record. There is no shared root timing document or timing counter. Usage receipts are the per-request data added by this decision.

Pi retires literal `scope: "task"` documents in the terminal commit, including documents created in that commit. The storage probe and SQLite reopen tests reproduced their disappearance. Use conversation document families for timing and check sources, with a separate member per task ID. This scopes each value to its producing task without a shared root value or counter, and retains it after settlement. This is an implementation correction to the attack's proposed Pi scope.

Pi Durable 1.0.0 has no task timestamps. Upgrade Pi Durable, pi-ai and Chord to 1.1.0, which introduced durable task `startedAt` and `endedAt`. The installed declarations and changelog define these as the first running transition and the terminal transition, using the harness clock. A faulted task's end comes from that task record: Melian has no terminal commit in which to record it. Never sample the read clock as a substitute.

#### Stage identity and selection

The vocabulary is `melian.triage`, `melian.check`, `melian.lens`, `melian.verification.candidate`, `melian.adjudication`, `melian.walkthrough` and `melian.publication`. Each row names its task and, for a model stage, its conversation. A lens subject includes name, version and level. Quick and escalated runs have separate intervals. A verifier subject names its candidate. No synthetic parent interval is added to its children.

Read the review, decisions, checks and summary indexes to select a revision's tasks. A per-task check-source map keeps each check's producing task, including checks kept across repeated `--rerun` calls. This map stays outside check records and inputs. Publication selects by its stored target revision, so review, dismiss, publish records publication even after dismissal replaces adjudication. Retired tasks cannot supply the current review's model stages.

Telemetry never enters task inputs, attach keys, findings, verdicts or publication fingerprints. Repeating a review attaches to the same tasks. No timing record grows when a caller attaches or reads. Timing storage grows with stages. Usage receipts grow with returned requests. One process owns each store at a time, as Pi requires; task-scoped records do not add cross-process locking.

#### Transcript authority

A conversation's first admitted input message supplies the start timestamp. Its final settled submission's answer supplies the end: `timestamp + (durationMs ?? 0)` for an assistant message. Pi defines `timestamp` as request start and `durationMs` as milliseconds until the response ended. If duration is absent, use the timestamp and note that response duration is unavailable. A settled unanswered run uses its last timestamped transcript entry. An active submission has no end. Admission is idempotent by request ID, and replay does not restamp entries. A crash after Pi settles a submission cannot stretch its end to the resume time. Provider failover stays inside that conversation's interval. A faulted owning task supplies its durable fault end only when the conversation has no settled end of its own.

Usage comes from Pi's UsageDoc once per conversation, including generation retries, provider failover, tool continuations and compaction attempts. Each stage exposes models keyed by actual provider/model and a total. Each model keeps Pi's input, output, cacheRead, cacheWrite, optional cacheWrite1h, optional reasoning, totalTokens and cost fields. Prices are USD. Sum reported totalTokens and cost.total; never rebuild either from components or catalogue prices. Reasoning is already included in output, and cacheWrite1h in cacheWrite. Missing optional counters stay absent. A reported zero remains zero.

Core's Decider and TextModel ports accept an optional usage observer, separate from their request. FallbackDecider forwards it. RouteTextModel reports the returned assistant message's own provider, model and usage before validating stop reason or tool arguments. Thus a response that becomes a failed decision still counts. A task-local collector sums those records. DecisionTask writes its collector to a new melian.model-usage document-family member, keyed by task ID, in the same terminal commit as its decision or failure. UsageObserver also has an optional started callback. A model adapter awaits it before each provider request; FallbackDecider forwards the observer unchanged. DecisionTask increments started in a separate melian.model-attempts document-family member before dispatch. Its terminal result commit compares started with the number of response receipts collected in that invocation and stores their difference as unmeasured. This pair keeps one family member per task. Its usage value now retains request capture. Existing task shapes stay unchanged.

A crash before the terminal commit loses the in-memory receipts but retains started. Replay records another start. Telemetry reads unmeasured, exposes any positive count as usageIncomplete on the stage and run JSON, and prints `usage incomplete: N request(s) not measured` beside both subtotals. A provider that throws without a response leaves the same marker. A crash after settlement neither calls the provider nor increments either counter. No tokens or prices are estimated. A custom adapter must await started for every request and report each returned response once. A decider that asks no model starts no attempt.

Pi Durable 1.1.0 does not expose a durable count of actual dispatches or resends for conversation stages. The audit checked GenerationTask, GenerationCheckpoint, CompactionTask, CompactionCheckpoint, UsageDoc, GenerationHooks.beforeRequest and HookApi in its installed dist/harness API. GenerationCheckpoint.attempt and LiveDoc.generation.attempt describe logical retries; recovery repeats the request phase with the same attempt. CompactionCheckpoint similarly re-enters summarize with its prior attempt. Neither records another start on recovery. GenerationHooks.beforeRequest runs on recovery but exposes committed reads and first-writer-wins memos, not a dispatch counter. Compaction has no hook before every summarisation attempt. Partial streamed responses can survive through LiveDoc, but an absent partial cannot identify how many requests were lost. UsageDoc records settled response usage, through generation appendAssistant and compaction recordUsage. Thus lenses, verifier candidates and walkthroughs retain settled usage only. A request lost before settlement can remain unmeasured without a detectable count in those stages. Closing the remaining dispatch gap needs an upstream durable dispatch counter. The receipts added here cover returned responses only. Do not describe conversation totals as complete provider billing. Nothing estimates the lost tokens.

The usage family is version 2 for request capture. The attempts family remains version 1. Existing timing, decision, findings, verdict and publication shapes and versions are unchanged. This avoids the findings, verdict and publication upgrades in [pull request #144](https://github.com/melian-agent/melian/pull/144).

StageTelemetry sums each selected stage exactly once into its run total, grouped by model and token kind. It reports usageUnavailable stage IDs beside any known subtotal; when no stage supplies usage, total is absent. Old model stages never become invented zero spend. Reused stages retain their original spend and are included once. A new review selection retains the earlier decision's scope: retired lens, verifier and summary tasks do not join the current revision's total. These are totals of the selected stored review, including reused work, rather than incremental billing for the command invocation.

Nothing infers spend from duration or calls a model to measure it.

#### Replay and old tasks

A deterministic task's start is first-writer-wins. Its end and result share a terminal commit. The interval measures wall time until the result became durable, including interruption before settlement. The call marks an interval reused when its end precedes the call, and resumed when its start precedes the call and its end does not. Kept check sources are always marked reused.

Instrumented deterministic task versions increase. Migration marks a legacy checkpoint; such a task never stamps a new start. Its first resumed phase records a legacy marker in its own timing member. That marker survives a fault, whose Pi outcome clears memos and checkpoints. Its row says timing unavailable, with a note explaining the older build. Completed old tasks without a start get the same note. Model transcripts already carry timestamps across upgrades.

Retain both timestamps when the host clock regresses, clamp the duration to zero and mark `clockRegressed`. Intervals across hosts compare different clocks; a forward skew cannot be detected. Do not add overlapping intervals as total elapsed review time.

Outcomes describe execution: completed, failed, skipped, timed-out, provisional, ended, aborted, faulted, orphaned, superseded or running. A mutation skip whose cause is timeout is timed-out, retains its duration and participates in the slowest-stages line. A stage never started has no invented zero-length interval. Supersession comes from ownership and structured task state, never a match on error prose.

#### Detached reading and output

`TelemetryReader` reads storage through the detached API `ComparisonReader` uses. It opens no harness or scheduler, reconciles nothing and writes nothing. SQLite still configures WAL and checks its schema when opened; this is not a filesystem read-only mode.

`melian telemetry <range|#pr> [--json]` resolves local refs as findings does, fetches nothing and unlocks no credentials. JSON contains the selected revision, stages, per-model run total and usageUnavailable stage IDs. Text lists subject, outcome, start, end, duration, reuse and available spend. Missing timing explains its absence. Exit 0 means stages printed, 1 means none or unreadable storage, and 64 means invalid arguments.

`melian review --json` is new. It prints `verdict.renderJson()` fields with telemetry beside them, including on attachment. Text review keeps its verdict rendering. Standard error gets one line naming up to three slowest ended intervals, ordered by duration, then name and subject, followed by recorded total tokens and cost. Text telemetry also prints each stage's token kinds and per-model spend and the run total. Unavailable or unfinished intervals do not rank; timed-out checks do. Every head-controlled string, including stage names and errors, passes through `visibleText` in terminal output. JSON uses normal JSON escaping. Telemetry stores no prompts, completions, whole payloads or credentials. It retains only the selected reasoning settings from a request body.

A review that fails after opening storage can print partial telemetry beside its error in JSON. A failure before storage opens has no telemetry. Neither invents a verdict. Errors keep existing exit codes.

#### Eval spend

Lens and verifier runs read TelemetryReader before closing their store and return the same StageTelemetry record with the score's inputs. Their score lines print that record's tokens and cost, with partial coverage made explicit. A failed run carries its detached record with the error, so no-score output can still show spend. Triage exports each pass's detached record through its runner and stores each pass's full detached telemetry with its measurement JSON. The printed measurement includes each golden's score, tokens and cost. Old measurement files have no telemetry field. Fake finder and lens identities remain visible alongside real models; none is relabelled as paid spend. Terminal output escapes head-controlled text.

#### Deferred Pi telemetry

Do not add pi-telemetry instrumentation. Pi Durable passes no telemetry context and emits no spans. A pi-telemetry span cannot outlive its callback, while a durable stage crosses processes. A Melian projection under Pi's span names would be a parallel tracer. Reconsider the bridge when Pi Durable passes a telemetry context. Existing durable facts can then feed an exporter without changing task identity or timing authority.

#### Proof

Tests cover settlement before a crash, fault endings, three check runs, dismissal before publication, unchanged storage on reads, old-version reopening, stable task IDs on attachment, timeout ranking and terminal escaping. A mutation inventory records each changed guard, branch, bound and early return and the test that kills it. The pass runs the whole gate and reports sandbox limits without weakening checks.
