# Issue 521: a past miss measured with the whole review

[Issue #521](https://github.com/melian-agent/melian/issues/521).

## A prober's record keeps every skip

Codex's seventh review of [pull request #518](https://github.com/melian-agent/melian/pull/518), at 265bb34e, found that `TelemetryReader.proberRecord` dropped a skip's reason once the prober later probed the same attack. The record is the audit trail, so it now keeps every skip. The stage's `skipped` count still treats such an attack as probed.

The test came first. `probing-level.test.ts`, "shows the prober's plan size, its skips, and how each probe ended", skips attack 2 and then probes it. With the record expected to hold that skip, it failed at ded386ca with `-  "attack": 2, "reason": "it needs the network"` missing from the record. With the fix, it passed.

## A measurement names the lenses that probe

`MELIAN_EVAL_PROBE_LENSES` names the lenses a probing run gives the probing deep level, comma-separated, and defaults to `trust-boundary`, so a run without it repeats the first measurement. Every lens it names gets the same planner and prober routes. It applies to goldens and misses alike.

The run asks core whether each named lens may probe. `Lens.probeRefusal()` in `packages/core/src/lens.ts` returns the reason a level that set `probe` would be refused at load: `tests` until [issue #493](https://github.com/melian-agent/melian/issues/493) lands, and any lens without probing wording. `resolveLevels` and the new method share one function, so the evals package never restates the rule. A name the base's policy does not load is refused too, and so are a repeat and an empty list.

The tests came first. In `packages/core/test/lens.test.ts`, "says why a loaded lens may not probe" failed at b648f89c with `lens.probeRefusal is not a function`. In `packages/evals/test/probing.test.ts`, "probes each lens the run names" and "refuses a lens core would not let probe" failed because `ProbingCombination` ignored the list. With the change, all 148 core lens tests and all 60 probing tests pass.

## A golden's lines are answered at each claim's own sighting

[Pull request #518](https://github.com/melian-agent/melian/pull/518) gave an expectation `lines`, and four reviews each found a merged claim placed where it was not reported: at the speaker's place, at a cause in another file, at a cause the merge copied, and at a member's place that adjudication kept. Each fix read the best place the merged finding still held. The coordinator directed the fix, not a ruling: score a line-scoped expectation on each claim's own sighting, found by claim ID and version, and leave `melian.verdicts` unversioned.

Every review now returns each lens check's own sightings at the head, read level by level, in place of the one check a target named. `answers` places each claim of a finding at its own sighting: the members in `otherClaims`, and the speaker once for each check and level in `reportedBy`. A guardrail's claim is its own finding. A lens claim with no sighting throws, and so does scoring an expectation with lines without the sightings. An expectation without `lines` scores as before.

The tests came first. In `packages/evals/test/goldens.test.ts`, the describe block "an expectation with lines, answered at each claim's own sighting" ran against 5128206e's scorer in a throwaway worktree: four of its six tests failed. A member sighted at 11 with the speaker at 30 found 0, expected 1 (line 1399). A merged finding at a member's kept place 11, with the speaker sighted at 30, found 1, expected 0 (line 1428), Codex review 8's instance. A speaker reported by two levels, one sighted at 11, found 0, expected 1 (line 1439). Scoring without sightings did not throw (line 1484). The two that passed cover the cross-file instance and refuted claims, which the old scorer already handled. With the change, all 163 goldens tests and all 60 probing tests pass.

## A miss can be measured with the whole review

`MELIAN_EVAL_MISS_REVIEW=whole` reviews each miss with every lens in the base's `full` tier, in place of `trust-boundary` alone. It defaults to `lens`, which repeats the first measurement. A whole run scores a miss on every lens check's own sightings, with each claim held by its check, ID and level, so a sighting another lens made can find it. It scores only a miss with hand-entered `lines`, since the whole review's other lenses sight more of the file than the miss, and it refuses one without, by name, before any provider.

A miss may name `alternativeRules` beside its `rule`, and a sighting under any of them finds it. A miss may leave out `rule` only when it has `lines`; then a sighting under any rule at those lines finds it. Each rule must be one some lens of the base's `full` tier declares for the file, in either mode, so one misses file serves both and a misspelt alternative fails at load. In `lens` mode one of the rules must be `trust-boundary`'s.

A miss is unscored rather than missed when no responsible lens saw its lines: each lens the review runs that covers the file and declares one of its rules, or all of them when it names none. The results file records each such lens as `not run` or `never shown`, and each miss's `foundBy` and `probedBy`. Its `version` is 2, and it names the mode and the probing lenses.

The tests came first. Run against 247e5ead in a throwaway worktree, 14 of the 64 probing tests failed. Among them, "scores a miss in whole mode on a lens other than trust-boundary, under its alternative rule, and in lens mode as before" scripts `correctness` to report `wrong-result` at `src/scan.ts:16` of the `trust-boundary-fail-open` golden and `trust-boundary` to report nothing. It failed because the old match read `trust-boundary`'s sightings alone. "scores a miss in whole mode only on its lines, and records each responsible lens that never saw them and each prober that completed" failed because the old settings ignored the mode. The others failed on the new field names, wording and refusals. With the change, all 64 pass.

## The guideline gives each mode and its cost

`docs/guidelines/evals.md` now names `MELIAN_EVAL_PROBE_LENSES` and `MELIAN_EVAL_MISS_REVIEW`, the optional `rule` and `alternativeRules`, the responsible lenses, `not run` and `never shown`, and the results file's version 2 fields. It says `MELIAN_EVAL_PROBE_LENSES` changes levels in memory only, so a measurement with it is not the committed policy's behaviour. Its new "Miss review cost" section gives each mode's cost: on the scripted `trust-boundary-fail-open` golden, `whole` mode ran six lens conversations and a verification where `lens` mode ran one.

## Every lens that probes follows the combination

The first Melian round on [pull request #550](https://github.com/melian-agent/melian/pull/550), at e2ac049d, found that `ProbingCombination.routed` held only the lenses `MELIAN_EVAL_PROBE_LENSES` names to the combination. A lens whose level already probed kept its committed planner and prober, and its probes in the arm without probes. In `whole` mode on Melian's own tier, `trust-boundary-probes` probes at `deep`. In `lens` mode with the setting naming only `correctness`, `Miss.target` makes `trust-boundary` probe. Either way an arm's results measured probes it did not route. `routed` now holds every lens with a probing level to the combination, as well as each named one; only a named lens gains a probe at `deep` that its lens does not declare.

The test came first. In `packages/evals/test/probing.test.ts`, "holds every lens whose level probes to the combination, named or not, and gives only a named lens a probe" names only `correctness` and gives `conventions` a probing `careful` level. It failed at e2ac049d with `expected { level: { floor: 'deep' } } to deeply equal { level: { floor: 'deep' }, …(1) }`: `trust-boundary` kept its committed route. With the fix, all 65 probing tests pass. The test replaces an assertion of the old behaviour, that `trust-boundary` loaded unchanged when only `correctness` was named.

## Mutants

`2026-11-17-issue-521-whole-review-misses-mutants.json`, beside this entry, holds the whole version-2 output of `melian mutants list e6ed960b...ffd33df3 --json --all`, with claims in `packages/evals/src/probing.ts` and `packages/core/src/lens.ts`: 547 mutants, none omitted. Those two files hold 384 generated mutants and 79 ignored ones. Each claimed mutant ran against its named test alone, anchored by its ancestor titles and title, and exactly one test was collected each time. The source has not changed since ffd33df3; three later commits add tests.

- 359 are killed by an existing test.
- 19 needed a new test. Four survived at e2ac049d, the decision on which lenses review a miss and the refusal's wording, and "reviews a miss with the base's full tier in whole mode…" kills them. At 840efb64 and 5e2e66ea, four more tests close the rest: a miss whose file is cut after a whole line, a miss without a rule, which lenses a miss's target probes, a combination that names several lenses sharing the prober's tier, and probers recorded in order.
- 6 are equivalent, each with its reason. In one, `lensProbingWording.has(undefined)` is already false. In another, a lens's levels never hold an undefined level. In a third, `files.includes(undefined)` is false. In the fourth, only `melian.lens` stages carry coverage. In the fifth, a refused miss throws before the branch. In the sixth, the results leave only as JSON, which drops an undefined `unseen`.

Each change of `probing.test.ts` reran the claims it could affect, so each claim's run holds at 5e2e66ea. The first change reran all 305 claims named in that file, and the second reran the 33 claims named in the test it edited and the 8 survivors. The 23 claims named in `packages/core/test/lens.test.ts` ran at efa374e3; that file has not changed since.

The review of record at f4246d5c found that the first copy of this inventory could not be sampled. `scripts/enumerate-mutants.mjs` had written it in the legacy shape, and a legacy inventory owes a claim on its 79 ignored `StringLiteral` rows too, so `enumerate-mutants.mjs --sample` exited 1 with `each mutant needs a claim: killed, new-test or equivalent`. The inventory is now `melian mutants list`'s version 2, the same 547 mutants, where an ignored row owes none. Each claim moved across by its identity, its evidence became a test's file and title path or a reason, and the sampler exits 0.

The review of record also found that `MELIAN_EVAL_PROBE_LENSES=tests` ended the run with exit 1, not the exit 2 the evals guideline promises. `ProbingCombination.routed` refused the lens, but it runs inside each review, so the refusal scored that review "no score" and the run went on. Now `routed` throws a `ProbeLensRefusal`, which no review catches, and the first review that meets one ends the run with exit 2 before its provider is called. A lens the policy does not load ends the run the same way. The test "exits 2 at the first review for a probe lens core refuses, or one the golden's policy does not load" runs the real `runGolden`. At 6a760c57 it failed with `tests: expected [] to deeply equal [ StringMatching /^MELIAN_EVAL_PROBE_LENSES names tests, which cannot probe: …/ ]`, because nothing reached the error output; with the fix it passes.
