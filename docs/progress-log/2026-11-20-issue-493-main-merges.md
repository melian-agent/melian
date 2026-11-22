# Issue #493: main merged twice, after the lens budgets and the code hashes

Two merges of `main` brought [pull request #532](https://github.com/melian-agent/melian/pull/532) up to date with the raised lens budgets of [pull request #584](https://github.com/melian-agent/melian/pull/584) and the code hashes of [pull request #579](https://github.com/melian-agent/melian/pull/579).

- `probeRefusal` in core's `lens.ts` takes `main`'s form and drops the refusal for the tests lens, which this branch lets probe. The evals tests that named the tests lens as refused now name contracts.
- `unprobedSkips` in `telemetry.ts` keeps `main`'s full skip record and this branch's rule that only a conclusive probe answers a skip.
- `caveats-reopen.test.ts` reads the lens task and the adjudication task at version 8, one bump from each side.
- `npm run code-hashes` regenerated `packages/pipeline/src/code-hashes.ts` for the branch's changes.
- `adjudication-key-reopen.test.ts` expects this build's `verifierVersion` in the provenance of main's verdict decided again, since issue #493 moves it on purpose.

## Mutants rerun at the merge

The merge rewrote `unprobedSkips`, and its resolution changed the named test, "a level that probes > shows the prober's plan size, its skips, and how each probe ended in the stage telemetry, and its text in its record alone". Every Stryker mutant on `telemetry.ts` lines 979 to 983, and the carried claim at `probing.ts:357`, columns 8 to 45, `ConditionalExpression` to `true`, ran against that test alone at `197d7006`. The test passed unmutated and collected one test each run. All 13 failed mutated: 12 in `telemetry.ts` (`BlockStatement`, `MethodExpression` twice, `LogicalOperator` twice, `ArrowFunction` twice, `BooleanLiteral`, `ConditionalExpression` four times, `EqualityOperator`) and the one in `probing.ts`. No other claim in the issue #493 inventories names a test the merges changed.
