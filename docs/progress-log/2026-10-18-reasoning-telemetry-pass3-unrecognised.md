# Reasoning telemetry: unknown parameter capture

[Pull request #153](https://github.com/melian-agent/melian/pull/153), pass 3, follows the installed-adapter fix at 151ad84f.

The runtime now marks source unrecognised when an observed reasoning-shaped parameter has no captured path. It keeps known settings and never stores unknown names or values. Prompts, tool declarations, schemas, metadata and headers stay opaque. Later callbacks cannot clear a gap. The new decision defines the status and the offline adapter check.

Eight failure scenarios failed before implementation: seven unknown parameter shapes and a mixed known/unknown request. Negative controls passed. The tests also cover callback replacements, arrays, recognised containers and omitted fields. Text and JSON keep the status.

The usage family moves to version 3 for the new source status. Before that change, 151ad84f wrote a v2 fixture through its own ConversationUsageRecorder. The reopen tests preserve both v1 and v2 through a v3 write and another reopen. The existing document-version assertion changes mechanically from 2 to 3. No Pi document or task version changes. This fix pass leaves the implementation plan unchanged.

Mutation proofs and the full gate result are recorded in tmp/reasoning-telemetry-pass3-report.md. Host mutation and review rounds remain with the coordinator: this pass makes no live model call.

Validation: all 96 focused tests pass. Forty-one hand mutations are killed: two for the adapter fix and 39 for the scanner, status and callback handling. The inventory exposed a reasoning-only classifier test gap; its new case kills that survivor. A dotted-key regression also failed before the path comparison fix.

The whole gate exits 1 with 4,935 tests passing and 53 skipped, in 455.42 seconds. Formatting, type checking, tooling and the audit threshold pass. The four failures match pass 2: three ps failed: undefined errors and the supervisor's toolFailed/invalidOutput mismatch under that denial. There are no timeouts or new test failures.
