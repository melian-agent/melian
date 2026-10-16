# Stage telemetry

Status: accepted for milestone 2, step 31. Pass 2 implements the smaller design accepted after [pull request #135](https://github.com/melian-agent/melian/pull/135)'s attacking review.

## Problem

A review records findings and spend, but no stage duration. A 240-line round took 64 minutes. On [pull request #131](https://github.com/melian-agent/melian/pull/131), mutation testing repeated the whole suite after NoCoverage. Nothing showed how much of the round it took.

## Decision

Ask Pi for the facts it already stores. Derive lens, verifier-candidate and walkthrough intervals from their durable transcripts at read time. Add no records to those tasks. Each deterministic stage stores its first start through `runtime.memo("telemetry.start", runtime.now())`. Its own terminal commit copies that start and an end from `runtime.now()` into its own `melian.stage-timing` document-family member, keyed by task ID. Triage, each check, adjudication and publication use this record. There is no shared root timing document, counter or per-call log.

Pi retires literal `scope: "task"` documents in the terminal commit, including documents created in that commit. The storage probe and SQLite reopen tests reproduced their disappearance. Use conversation document families for timing and check sources, with a separate member per task ID. This scopes each value to its producing task without a shared root value or counter, and retains it after settlement. This is an implementation correction to the attack's proposed Pi scope.

Pi Durable 1.0.0 has no task timestamps. Upgrade Pi Durable, pi-ai and Chord to 1.1.0, which introduced durable task `startedAt` and `endedAt`. The installed declarations and changelog define these as the first running transition and the terminal transition, using the harness clock. A faulted task's end comes from that task record: Melian has no terminal commit in which to record it. Never sample the read clock as a substitute.

### Stage identity and selection

The vocabulary is `melian.triage`, `melian.check`, `melian.lens`, `melian.verification.candidate`, `melian.adjudication`, `melian.walkthrough` and `melian.publication`. Each row names its task and, for a model stage, its conversation. A lens subject includes name, version and level. Quick and escalated runs have separate intervals. A verifier subject names its candidate. No synthetic parent interval is added to its children.

Read the review, decisions, checks and summary indexes to select a revision's tasks. A per-task check-source map keeps each check's producing task, including checks kept across repeated `--rerun` calls. This map stays outside check records and inputs. Publication selects by its stored target revision, so review, dismiss, publish records publication even after dismissal replaces adjudication. Retired tasks cannot supply the current review's model stages.

Telemetry never enters task inputs, attach keys, findings, verdicts or publication fingerprints. Repeating a review attaches to the same tasks. No timing record grows when a caller attaches or reads. Storage grows with stages, not calls. One process owns each store at a time, as Pi requires; task-scoped records do not add cross-process locking.

### Transcript authority

A conversation's first admitted input message supplies the start timestamp. Its final settled submission's answer supplies the end. A settled unanswered run uses its last timestamped transcript entry. An active submission has no end. Admission is idempotent by request ID, and replay does not restamp entries. A crash after Pi settles a submission cannot stretch its end to the resume time. Provider failover stays inside that conversation's interval. A faulted owning task supplies its durable fault end instead.

Spend comes from Pi's `UsageDoc`, once per conversation, with model names, tokens and USD cost. Absent usage stays absent. Nothing infers spend from duration or calls a model to measure it.

### Replay and old tasks

A deterministic task's start is first-writer-wins. Its end and result share a terminal commit. The interval measures wall time until the result became durable, including interruption before settlement. The call marks an interval reused when its end precedes the call, and resumed when its start precedes the call and its end does not. Kept check sources are always marked reused.

Instrumented deterministic task versions increase. Migration marks a legacy checkpoint; such a task never stamps a new start. Its first resumed phase records a legacy marker in its own timing member. That marker survives a fault, whose Pi outcome clears memos and checkpoints. Its row says timing unavailable, with a note explaining the older build. Completed old tasks without a start get the same note. Model transcripts already carry timestamps across upgrades.

Retain both timestamps when the host clock regresses, clamp the duration to zero and mark `clockRegressed`. Intervals across hosts compare different clocks; a forward skew cannot be detected. Do not add overlapping intervals as total elapsed review time.

Outcomes describe execution: completed, failed, skipped, timed-out, provisional, ended, aborted, faulted, orphaned, superseded or running. A mutation skip whose cause is timeout is timed-out, retains its duration and participates in the slowest-stages line. A stage never started has no invented zero-length interval. Supersession comes from ownership and structured task state, never a match on error prose.

### Detached reading and output

`TelemetryReader` reads storage through the detached API `ComparisonReader` uses. It opens no harness or scheduler, reconciles nothing and writes nothing. SQLite still configures WAL and checks its schema when opened; this is not a filesystem read-only mode.

`melian telemetry <range|#pr> [--json]` resolves local refs as findings does, fetches nothing and unlocks no credentials. JSON contains the selected revision and stages. Text lists subject, outcome, start, end, duration, reuse and available spend. Missing timing explains its absence. Exit 0 means stages printed, 1 means none or unreadable storage, and 64 means invalid arguments.

`melian review --json` is new. It prints `verdict.renderJson()` fields with telemetry beside them, including on attachment. Text review keeps its verdict rendering. Standard error gets one line naming up to three slowest ended intervals, ordered by duration, then name and subject. Unavailable or unfinished intervals do not rank; timed-out checks do. Every head-controlled string, including stage names and errors, passes through `visibleText` in terminal output. JSON uses normal JSON escaping. Telemetry stores no prompts, completions, payloads or credentials.

A review that fails after opening storage can print partial telemetry beside its error in JSON. A failure before storage opens has no telemetry. Neither invents a verdict. Errors keep existing exit codes.

### Deferred Pi telemetry

Do not add pi-telemetry instrumentation. Pi Durable passes no telemetry context and emits no spans. A pi-telemetry span cannot outlive its callback, while a durable stage crosses processes. A Melian projection under Pi's span names would be a parallel tracer. Reconsider the bridge when Pi Durable passes a telemetry context. Existing durable facts can then feed an exporter without changing task identity or timing authority.

### Proof

Tests cover settlement before a crash, fault endings, three check runs, dismissal before publication, unchanged storage on reads, old-version reopening, stable task IDs on attachment, timeout ranking and terminal escaping. A mutation inventory records each changed guard, branch, bound and early return and the test that kills it. The pass runs the whole gate and reports sandbox limits without weakening checks.
