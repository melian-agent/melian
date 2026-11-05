# Render the outcomes adjudication recorded

Fix pass for [issue #213](https://github.com/melian-agent/melian/issues/213) and [pull request #221](https://github.com/melian-agent/melian/pull/221).

Run rows now take their outcomes from the indexed adjudication task’s check records.
A check without a conversation still gets a row. A reused failure stays failed.
Conversation telemetry retains its terminal status and timings.
A quick conversation whose budget ended can belong to a lens check recorded as ran; its row now says ran and retains the budget evidence.

The existing two-claim, guarded-verifier-fallback and refused-tier cases failed on the starting head: the verifier rows said ran and the refused lens rows were absent.
All three pass after the fix. A fourth case covers a completed lens whose fallback the plan refuses.
Additional checks cover synthetic rows, each check status, absent inputs and reused failures.
The host runs the full gate; this pass runs only the six affected test files and TypeScript.

All 69 enumerated mutants were applied individually: 68 killed, one equivalent, none omitted.
The first run exposed three gaps in matching lens conversations; the refused-fallback assertion kills all three.
The [complete inventory](2026-10-26-quiet-run-details-outcomes-mutants.json) records the named failing tests and the equivalence reason.
