# Stage telemetry: design and failing tests

Phase 1 of milestone 2, step 31, on `stage-telemetry`. [The proposed decision](../decisions/2026-10-16-stage-telemetry.md) defines the durable projection, stage boundaries and CLI output. Implementation waits for the coordinator's attacking review and go-ahead.

Pi telemetry 1.0.0 supplies callback-managed spans and typed schemas. Its in-memory recorder has no timestamps. Pi Durable 1.0.0 accepts no telemetry context and emits no task or model-request spans. Its usage document supplies model spend. The design records wall time across a crash and keeps completed timings when another review reuses work.

Four tests run through existing entry points. They reach the missing feature and fail there:

```text
stores every stage, with quick and escalated lenses separate, through publication
  a completed review must leave durable stage spans: expected undefined to be defined
marks finished stages reused and preserves their original intervals and spend
  an attached review must record reused stages: expected undefined to be defined
keeps completed quick timing and the active escalation's first start across a real kill
  stage checkpoints must survive without a verdict: expected undefined to be defined
includes durable stage telemetry in review JSON
  review --json must carry the stored telemetry record: expected terminal text to contain '"telemetry":'
```

The targeted run exits 1: four failures, 62 tests outside its filter skipped. The crash test kills a child at a parked escalation, reopens SQLite and completes its resumed request before checking telemetry. Publication uses a fake GitHub transport and crosses a storage close and reopen. The repeat test confirms attachment asks no model or static tool again. Static runners are request-checked stubs; this phase measures no real Stryker run.

The whole gate exits 1: 4,308 tests passed, eight failed and 53 skipped. Four failures are the intended telemetry tests. Four existing process tests need `ps`, which this task cannot execute. They are the real-child signal test, both real mutation-backend tests, and the supervisor's no-second-Stryker test. The first three report `ps failed: undefined`; the last returns `toolFailed` because its shell cannot inspect its parent. No timeout failed. Linting, dependency checks, type checking and the configured audit gate passed. The coordinator must run the whole gate on the host.

The full targeted output and gate log are local, under `tmp/stage-telemetry-phase1-red.log` and `tmp/stage-telemetry-check.log`. `tmp/stage-telemetry-phase1-report.md` holds the handover and mutation inventory.

No production source or production guard changed, so this phase claims no mutation proof. The branch diff was reviewed locally. No live model calls, companion review or Melian round ran. Phase 2 must make the tests pass and prove its guards, branches, bounds and early returns by mutation. No comparison record was edited.
