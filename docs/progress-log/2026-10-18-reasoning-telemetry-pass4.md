# Reasoning telemetry: caller payload hooks

[Pull request #153](https://github.com/melian-agent/melian/pull/153), pass 4, addresses findings b6d57ef7b5b7d638 and 4e6659a2f6881a62.

Both decorators now have a test passing an asynchronous caller onPayload hook that replaces effort none with high.
Each test checks the body received by the fake provider, one hook call and the stored observed capture.
The existing production code passes both tests; no production change was needed.

Removing the caller hook from capture.options at each decorator separately fails its corresponding test: the provider receives none instead of high.
The other decorator test passes during each mutation. Both mutations were restored.
All 58 tests in reasoning-telemetry.test.ts pass with source restored.
The mutation inventory and failing logs are recorded in tmp/reasoning-telemetry-pass4-report.md and tmp/reasoning-telemetry-mutations.json.

The implementation plan stays unchanged for this test-only fix pass.

The whole gate exits 1: 4,937 tests pass, 53 skip and four fail on existing sandbox ps restrictions.
The failures are the real-process pid test, both real mutation backend tests and the supervisor termination test.
Formatting, type checking, release checks and the audit threshold pass. No timeout or new failure occurred.
The coordinator must rerun the whole gate on the host, as lane-common requires.
