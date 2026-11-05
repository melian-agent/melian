# Keep escalated lens outcomes separate

Fix pass 5 for [issue #213](https://github.com/melian-agent/melian/issues/213) and [pull request #221](https://github.com/melian-agent/melian/pull/221).

The run projector matched lens check records by name and version, ignoring scrutiny level.
A careful run's settled record overwrote the quick run's outcome.
It now requires the recorded level to match the stage subject.
Older check records without a level retain the name-and-version fallback, named in the source comment.

At starting head `5e1523c8bad4884e79311cb9b2f422db1fb3eac9`, both new escalation cases failed for the reported reason.
The quick tools-budget ending rendered `ran` beside a completed careful run.
The completed quick run rendered `failed` beside a failed careful run.
After the fix, both cases and the legacy fallback pass.
The initial focused run passed both telemetry and recorded-check files, 42 tests.

The existing budget-row integration test expected the settled careful outcome on the first, quick row.
It failed after this fix with expected `ran`, received `ended`.
Its assertion now names both levels and checks quick `ended` beside careful `ran`, retaining both token-budget assertions.
No tests from the triage merge changed.

The [committed inventory](2026-10-27-quiet-run-details-level-outcomes-mutants.json) records all seven enumerated mutants, with none omitted.
Every mutant was applied separately and killed by the named escalation tests, including the ignored string mutant.
There are no survivors or equivalence claims. The inventory includes the scratch runner, coordinates, test commands and failing test names.
Its SHA-256 binds the proof to the restored production source.

The initial broader package run was stopped to honour the direct instruction to run targeted files only in the sandbox.
A combined targeted run under load above 60 hit three five-second CLI timeouts.
The CLI publication file then passed alone, all eight tests, including those three.
The final serial pipeline run passed all 89 tests across `telemetry`, `run-check-outcomes`, `run-details`, `stage-telemetry`, `stage-telemetry-reopen` and `round-run`.
Together with CLI `publish-run`, 97 targeted tests pass across seven files.
Both final commands used `npx vitest --run --maxWorkers=1` with the named test paths.
Biome, `git diff --check` and review of the fix diff passed before commit.
The host owns the whole package suites and `npm run check` gate; no full-gate pass is claimed.
No comparison record or implementation-plan status changes belong to this fix pass.
