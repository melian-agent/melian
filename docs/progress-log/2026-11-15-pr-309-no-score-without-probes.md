# Pull request #309: no score for a golden that ran without probes

Builder agent: a live run of a probing golden that fell back to an ordinary lens run now ends with no score, in [pull request #309](https://github.com/melian-agent/melian/pull/309).

## The finding

Codex's adversarial review at `01010554` raised one medium finding at `packages/evals/src/goldens.ts:403-405`.

When `Probe.availability` fails, `reviewChangeset` runs the lens without probes and notes why on its check record. `runGolden` dropped that note and returned the findings for scoring. Example: a live run on a host without sandbox-runtime scores the trust-boundary golden as if the lens had probed, though it only read the code. The sandbox test accepted that run.

## The fix

After the review, `runGolden` looks for a check record, ran or not run, whose reason says a level "ran without probes". When it finds one, the run throws. The existing catch wraps that in `GoldenRunError` with the review's telemetry, so the live report prints "no score", with the reason and the spend, and exits unsuccessfully. The message names the lens and the review's whole reason, such as `lens.trust-boundary: deep ran without probes, which cannot run here: no sandbox-runtime here`.

The note covers all three fallbacks the review records: no sandbox or a refused head, a plan that refuses the prober's tier, and a prober's tier that reaches no model. The review records them only as that text, so the check matches it, and the code comment says so. [`probing-level.test.ts`](../../packages/pipeline/test/probing-level.test.ts) asserts the wording.

The scripted path is unchanged in effect. A scripted golden's probes run unconfined, so none falls back, and all 139 tests in `goldens.test.ts` pass with the check applied to both modes.

## Tests

- **The sandbox test** now expects the live run to reject with `GoldenRunError` naming the lens and the reason. It still asserts the run asked the host's sandbox.
- **A new test** has the probing lens fall back, then spend its 60 tool calls and end at its budget. Its record lands in the verdict's `notRun`, which the check also reads.

The failing run, at `01010554` with the tests changed:

```
× probes a scripted golden unconfined where sandbox-runtime cannot run, and asks a live run's host for it
× gives no score to a live run whose probing lens fell back without probes and ended at its budget
AssertionError: promise resolved "{ golden: { …(5) }, findings: [], …(3) }" instead of rejecting
Tests  2 failed | 137 skipped (139)
```

After the fix: 139 of 139 passed.

## Mutants

`node scripts/enumerate-mutants.mjs` over the fix commit listed 11, with none omitted. Each ran against its named test alone, with one test collected:

- 10 killed by the sandbox test: both array declarations but the fallback's, `ran && []`, the predicate's `() => undefined`, `reason.includes`, `""`, the condition's `true`, `false` and `=== undefined`, the dropped throw, and the empty message.
- 1 equivalent: `["Stryker was here"]` for `ran ?? []`. A fresh verdict always sets `ran` (`adjudication.ts:1123`), and a string element has no `reason`, so `find` skips it.

Stryker has no mutant that drops the spread of `notRun`. A hand mutant that drops it lets the budget test's run resolve, so that test fails. That proves the test needs the `notRun` half.

This is trust code: a probing golden's score is the evidence that probes work. The change is one check in `runGolden`, two tests and this entry.
