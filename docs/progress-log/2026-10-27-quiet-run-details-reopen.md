# Keep legacy telemetry reads stable

Fix pass 2 for [issue #213](https://github.com/melian-agent/melian/issues/213) and [pull request #221](https://github.com/melian-agent/melian/pull/221).

The outcome fix added adjudication-only checks to the telemetry stage list.
Both old adjudication fixtures then returned eight stages instead of their one recorded task.
Those checks now travel separately and join the stages only when rendering run details.
Recorded check outcomes still override conversation status in the run table.

The two reopen tests and their expectations are unchanged.
The newer check-outcome test now asserts one recorded stage and unchanged run rows, including reused failures.
Its former stage-list assertion described the regression; correcting it restores the earlier read contract.
The pipeline guideline now states that adjudication-only checks add no telemetry stage.
No design decision or plan status changes.

Validation:

- On starting head `4a7472a9`, `npx vitest --run packages/pipeline/test/stage-telemetry-reopen.test.ts` failed both version-1 and version-2 cases: expected one stage, received eight. Eight other tests passed.
- After the fix, six files passed, 149 tests: `stage-telemetry-reopen`, `run-check-outcomes`, `stage-telemetry`, `run-details`, `verification` and `plan`, all under `packages/pipeline/test/`.
- After the mutation runs, `stage-telemetry-reopen`, `run-check-outcomes` and `run-details` passed again, 17 tests. TypeScript and Biome passed.
- `npx vitest --run packages/pipeline` finished with 2,030 passed, 17 failed and three skipped tests across 83 files. Thirteen failures passed when rerun with `MELIAN_STATE_DIR` unset: two authority-cache cases, ten static-cache cases and tool provisioning. Three real-process cases failed because the sandbox denies `ps`. The remaining supervisor test expected `invalidOutput` and received `toolFailed`; it failed identically against the starting head with `MELIAN_STATE_DIR` unset.
- The full gate was not run in the sandbox, as instructed. The coordinator must run it on the host.

The [complete mutation inventory](2026-10-27-quiet-run-details-reopen-mutants.json) lists nine mutants, none omitted.
A scratch script applied each replacement and ran `run-details.test.ts` and `run-check-outcomes.test.ts`.
Seven mutants failed named tests. Two seeded strings are equivalent: neither has a recognised stage name, so the run projector omits them.
The inventory keeps all coordinates, the source blob, test names, exit codes and equivalence reasons.
