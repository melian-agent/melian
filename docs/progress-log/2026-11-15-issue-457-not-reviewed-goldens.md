# Issue #457: a golden whose review is not reviewed gets no score

Builder agent: for [issue #457](https://github.com/melian-agent/melian/issues/457), `runGolden` now asks the verdict whether the review was reviewed, and a live golden's report prints each note a check that ran recorded.

## The defect

A live golden run whose verdict read `not-reviewed` still scored. The review of record for [pull request #309](https://github.com/melian-agent/melian/pull/309) showed two shapes:

- a probing lens whose prober leaves an attack with neither a probe nor a skip, which records `ended`;
- any lens that ends at its budget, which also records `ended`.

`runGolden` never read the verdict's status, so both runs scored. On the clean claim golden, the first scores as a clean pass.

## Why the verdict alone could not decide

Every golden reads `not-reviewed` today. `runGolden` runs the lenses alone: guardrails, `static.biome` and `static.tsc` never run, and the manifest holds them with no record. A check on `verdict.reviewStatus()` alone failed 102 of the 142 tests in `goldens.test.ts`.

## The fix

`runGolden` reads the checks the golden's tier names, with core's `checksOfTier`. It records each of core's `deterministicChecks` among them as skipped, "a golden runs its lenses alone", and lets each skip with leave through `checks.allowSkip`. It hands the review that tier, so both read one manifest. Then it fails any run whose `reviewStatus()` is `error`, with the status's description. That description names every check that did not run, with its reason. The existing catch wraps it in `GoldenRunError` with the run's telemetry, so the live report prints `no score`, the reasons and the spend, and exits 1.

Only a lens, the verifier or a decision question can now leave a golden's review not reviewed. A lens the policy turns off still does, since only the host checks skip with leave.

A scripted golden whose review is not reviewed fails its test, with the same message.

## The check from pull request #309 stays, narrowed

#309 failed a run whose check records said a level "ran without probes". A fallback that ends or fails lands in `notRun`, and the verdict's status now catches it. A fallback that finishes records `ran`, and the verdict reads reviewed. So the general rule covers the `notRun` half, and the check now reads `ran` alone. It stays, since a probing golden's score is the evidence that probes work, and a run that only read the code is no such evidence.

## The report line

[Issue #356](https://github.com/melian-agent/melian/issues/356) needs, per probing golden and pass, the attacks planned and the probes run. A probing lens's record already says both, as "it planned 2 attacks and ran 2 probes in 0.4 s". `GoldenRun` now carries the verdict's `ran` records, and `reportGoldens` prints each note one recorded, indented under the golden's score line. No text is parsed and no stored shape changes. A lens that ran with no note prints nothing, so the corpus's other goldens print as before.

## Tests

In `goldens.test.ts`, under "a golden whose review is not reviewed":

- **gives no score to a live run whose prober leaves an attack with neither a probe nor a skip**;
- **gives no score to a live run whose lens without probes ends at its budget**;
- **fails a scripted run whose lens ends at its budget**;
- **fails a scripted run whose policy disables a lens its tier names**.

The sandbox test now also asserts the probing lens's note. `live-output.test.ts` adds **prints each note a check that ran recorded under the golden's score, such as a probing lens's attacks**.

The four defect tests at `f7c66a0d`'s `goldens.ts`:

```
× gives no score to a live run whose prober leaves an attack with neither a probe nor a skip
× gives no score to a live run whose lens without probes ends at its budget
× fails a scripted run whose lens ends at its budget
AssertionError: promise resolved "{ golden: { …(5) }, findings: [], …(3) }" instead of rejecting
× fails a scripted run whose policy disables a lens its tier names
AssertionError: promise resolved "{ golden: { …(5) }, findings: [], …(3) }" instead of rejecting
```

With the fix, all 143 tests in `goldens.test.ts` pass.

## Mutants

`node scripts/enumerate-mutants.mjs f7c66a0d...HEAD` listed 29, with none omitted; 7 are ignored string literals. [The inventory](2026-11-15-issue-457-mutants.json) records each claim and its run. Each claimed mutant ran against its named test alone, at `7ece52b0`, with one test collected:

- **20 killed.**
  - The new rule's 12: `checksOfTier`'s filter dropped or emptied, the record, the leave and the tier replaced, and the status check's condition, comparison and throw. The named tests are `scripted clean-rename`, `scripted correctness-deleted-rethrow` and two of the new tests.
  - The narrowed check's 3, by the sandbox test.
  - The report line's 5: `ran && []` on the new field, by the sandbox test's note assertion, and the print's 4, by the new `reportGoldens` test.
- **2 equivalent.** Both are `["Stryker was here"]` for `ran ?? []`: a fresh verdict always sets `ran`, so the fallback is never read.

The first run, on the fix commit, left one survivor: dropping the filter on `checksOfTier`. Without the filter, every check the tier names may skip with leave, lenses included. **fails a scripted run whose policy disables a lens its tier names** now kills it, and fails on `f7c66a0d` for the reported reason.

Every claim was run again at the head, since a later commit changed `goldens.ts`, the file most claims mutate, and `goldens.test.ts`, where most named tests live.

This is trust code: it decides which live runs count as evidence for the retirement numbers.
