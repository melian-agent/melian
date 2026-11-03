# Record the final span and review endpoint together

The coordinator reported a one-millisecond endpoint mismatch in the first attempt of [CI run 41600772001](https://github.com/melian-agent/melian/actions/runs/41600772001).
The existing CLI timing assertion expected the prepare record to end with its final span.
`PrepareSpans.record()` closed the span with one clock read and sampled the record endpoint again.
Those reads can cross a millisecond. A passing retry did not disprove the defect.

At base `22a5ca0e5222cb0e6c51c950f2e4b44d61e48899`, a deterministic advancing-clock test failed with record endpoint 101 and final-span endpoint 100.
A separate closed-recorder control passed: end at 100, record at 250, preserve the span’s endpoint at 100.
Both assert the whole record using memory storage and fake models. Before the fix: one failed, one passed.
After the fix: both pass. Recording now samples one endpoint and passes it through a private closing helper.
Public `end(): void` and nested-span timing retain their behaviour. No schema or version changes.

The complete production-delta inventory against that base has three mutants, zero omitted.
Each applied mutant fails its named test. Three separate probes fail when either endpoint is resampled or a maximum-span shortcut erases the untimed tail.
The scratch runners restore source bytes in `finally` and record tuple hashes, source hashes, commands and actual results.
Evidence lives under `tmp/pr250-prepare-endpoint-fix/`, including before/after logs and the complete classified inventory.

All 15 prepare-span tests pass. The prepare-span and stage-telemetry suites pass 32 tests together.
The original CLI timing test passes, with its coverage assertion unchanged.
Focused Biome and repository type checking pass on Node 24.18.0.
The coordinator’s whole host gate, exact-head CI and final reviews remain pending; this executor did not run the whole gate.
