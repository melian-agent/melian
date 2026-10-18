# A reasoning level per tier

Built milestone 2 step 33 on `thinking-routes`, starting at `5175c664`.

Optional `models.<tier>.thinking` now follows root policy and working-tree preferences through planning and every model request path.
Thinking-only overrides preserve route derivation. Lens selection includes escalation thinking; verifier and triage identities separate levels.
Doctor prints each tier's level and setting file. Live evals accept per-run overrides and print levels through existing spend telemetry.
Committed routes remain unset. No dependency manifest or lockfile changes.

The [decision](../decisions/2026-10-19-tier-thinking-routes.md) updates the route contract and records the stored version changes.
Main-written fixtures pin unset provider bodies and reopen the previous task inputs and verdict database.
Fake-provider tests cover configured requests, both failovers, compaction, cache identity, local overrides, doctor and eval routing.
The branch report and mutation inventory live under `/Users/tal/dev/Melian/tmp/m2/scratch-thinking/`.

Pi generation and compaction both take the agent's configured thinking level. Direct triage instead needs pi-ai's simple completion API when explicit.
Keeping raw completion when unset preserves the request bodies captured from main.

The decision graph treats an old partial Supersedes declaration as whole retirement. A new decision can cite that history, but an Amends declaration must target an active decision.

Validation: 57 separate manual mutations were killed. Both whole-gate runs completed.
The corrected run passed 5,113 tests, with 53 skipped, and failed six: three denied ps probes, one supervisor toolFailed mismatch and two load timeouts.
The two timeout cases passed in the first run. No check or timeout was weakened.
A host gate and the automatic mutation sweep remain necessary; the report keeps the complete logs.
