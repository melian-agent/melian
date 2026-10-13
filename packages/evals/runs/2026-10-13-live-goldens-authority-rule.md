# Live golden run, the re-implemented authority rule, 2026-10-13

Three sets of figures, from three heads of [pull request #114](https://github.com/melian-agent/melian/pull/114). The coordinator ran three passes over the 27 `design` and `correctness` goldens at a2793b71. That run found a defect in a clean golden and a fault in the verifier eval harness. Both were fixed, and the goldens concerned were rerun at 8eeed1b1. The coordinator then ran three passes over the same 27 at ace07815, and [that run](#three-passes-at-ace07815) is the one the bars are read against. The lens text and the fixtures are the same at 8eeed1b1 and ace07815.

`openai-codex/gpt-6.1-sol` ran every lens tier and `openai-codex/gpt-5.6-terra` verified, one golden per invocation.

## Three passes at a2793b71

From 18:08 to 19:51. The per-golden lines come from the run's output, kept by the coordinator. A cell reads reported findings, precision, recall. `design-injection` printed no score in pass one: the process ended with a Node error, and that pass counts 26 goldens.

| Golden | Expected | Pass 1 (reported, precision, recall) | Pass 2 | Pass 3 |
|---|---|---|---|---|
| `correctness-deleted-guard` | 2 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `correctness-deleted-rethrow` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `correctness-null-deref` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-bound-on-wrong-measure` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-bound-on-wrong-measure-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-decision-injection` | 2 | 2, 1.00, 1.00 | 2, 1.00, 1.00 | 2, 1.00, 1.00 |
| `design-fail-open-default` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-identity-missing-input` | 1 | 2, 0.50, 1.00 | 2, 0.50, 1.00 | 2, 0.50, 1.00 |
| `design-injection` | 2 | no score | 3, 0.67, 1.00 | 2, 1.00, 1.00 |
| `design-reimplements-an-authority` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-reimplements-an-authority-clean` | 0 | 1, 0.00, 1.00 | 1, 0.00, 1.00 | 1, 0.00, 1.00 |
| `design-reimplements-an-authority-no-dependency-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-reimplements-an-authority-standard` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-reimplements-an-authority-unsupported-gap` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-resumed-identity` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-resumed-identity-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-rewrites-its-own-decision` | 1 | 1, 1.00, 1.00 | 2, 0.50, 1.00 | 2, 0.50, 1.00 |
| `design-single-slot-overwrite` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-single-slot-overwrite-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-superseded-at-base-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-supersedes-its-own-decision` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-terminology-change` | 1 | 2, 0.50, 1.00 | 2, 0.50, 1.00 | 2, 0.50, 1.00 |
| `design-terminology-change-in-design` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-trust-by-label` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-trust-by-label-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-unshipped-artifact` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |

[The evals guideline](../../docs/guidelines/evals.md) scores a lens's goldens together as one corpus, so the counts add before they divide. A golden's true positives are its precision times its reported count, and its found count is its recall times its expected count.

| Corpus | Pass | Goldens scored | Reported | True positives | Expected | Found | Precision | Recall |
|---|---|---|---|---|---|---|---|---|
| All 27 | 1 | 26 | 22 | 19 | 20 | 20 | 0.86 | 1.00 |
| All 27 | 2 | 27 | 26 | 21 | 22 | 22 | 0.81 | 1.00 |
| All 27 | 3 | 27 | 25 | 21 | 22 | 22 | 0.84 | 1.00 |
| `design` | 1 | 23 | 19 | 16 | 16 | 16 | 0.84 | 1.00 |
| `design` | 2 | 24 | 23 | 18 | 18 | 18 | 0.78 | 1.00 |
| `design` | 3 | 24 | 22 | 18 | 18 | 18 | 0.82 | 1.00 |
| `correctness` | 1 | 3 | 3 | 3 | 4 | 4 | 1.00 | 1.00 |
| `correctness` | 2 | 3 | 3 | 3 | 4 | 4 | 1.00 | 1.00 |
| `correctness` | 3 | 3 | 3 | 3 | 4 | 4 | 1.00 | 1.00 |

Recall was 1.00 in every pass. The `correctness` goldens scored as they did before the hand-off to `design` was added. The `design` corpus's worst precision was 0.78, under the bar of 0.8, and its worst recall 1.00. The coordinator's summary gave precision of about 0.91, 0.85 and 0.88; those are not the summed counts above, and are probably means of per-golden precision.

Six goldens account for every extra finding. `design-reimplements-an-authority-clean` reported one in each pass. `design-identity-missing-input` and `design-terminology-change` reported two for one expected in each pass, as in [the run of 2026-10-12](2026-10-12-live-goldens-design-terra.md). `design-rewrites-its-own-decision` did so in passes two and three, and `design-injection` reported three for two in pass two. Adjudicated precision was not measured.

## The clean golden was not clean

`design-reimplements-an-authority-clean` reported one finding in all three passes, and in a fourth run the coordinator made alone. A fifth run at a2793b71, with `MELIAN_EVAL_SHOW=1`, showed it: `reimplements-an-authority`, P2, `scripts/node-range.mjs` lines 6 to 8, confirmed by the verifier. Its failure scenario: with `engines.node` set to `>=022` and Node `v22.0.0`, the hand-written check reads `022` as 22 and allows the install, where `semver` refuses the range as invalid. npm's bundled `semver` 7.8.1 confirms that `satisfies("v22.0.0", ">=022")` is false.

The lens was right and the golden was wrong. The fixture stated a supported gap, but it answered an input where it should have refused, which the rule reports under a gap that holds. Commit 63afa9c5 makes the fixture refuse a leading zero, a major of 10000 or more, and a minor or patch of 1000000 or more. Over 8112 pairs of range and version, the fixture now answers true for none that `semver` 7.8.1 answers false. The lens text did not change.

## Reruns at 8eeed1b1

From 20:08 to 20:27, each golden alone.

| Golden | Expected | Passes | Each pass (reported, precision, recall) |
|---|---|---|---|
| `design-reimplements-an-authority-clean` | 0 | 5 | 0, 1.00, 1.00 |
| `design-reimplements-an-authority` | 1 | 3 | 1, 1.00, 1.00 |
| `design-reimplements-an-authority-unsupported-gap` | 1 | 3 | 1, 1.00, 1.00 |
| `design-reimplements-an-authority-standard` | 1 | 3 | 1, 1.00, 1.00 |

Every pass of a golden scored the same. In `design-reimplements-an-authority-standard` the one finding was `quoted-rule-violation` at P3 in all three passes, and the rendering showed no separate `reimplements-an-authority` finding. A `design` sighting on the same lines would merge into that finding and not show, so the run proves one reported defect, not `design`'s silence.

## The verifier goldens

At a2793b71, with one judgement per pass: `design-reimplements-an-authority-unsupported-gap` was unjudged twice and confirmed once, and `design-reimplements-an-authority-supported-gap` was unjudged once and refuted twice.

The cause was the provider, made worse by the harness. Six runs at 63afa9c5 with `MELIAN_EVAL_SHOW=1`, from 20:01 to 20:02, were all unjudged, and each ended within seconds. Four said "Codex error: An error occurred while processing your request", and two said "Codex error: Our servers are currently overloaded. Please try again later." No judge ran out of budget, and none finished without a verdict. `runVerifierGolden` opened its harness with retries off, so one failed request ended the judgement, where a review retries with backoff. Commit 8eeed1b1 leaves retries on and prints the reason beside `unjudged`.

Five passes each at 8eeed1b1, from 20:08 to 20:14:

| Verifier golden | Kind | Pass 1 | Pass 2 | Pass 3 | Pass 4 | Pass 5 |
|---|---|---|---|---|---|---|
| `design-reimplements-an-authority-unsupported-gap` | design | confirmed | confirmed | confirmed | unjudged | confirmed |
| `design-reimplements-an-authority-supported-gap` | decoy | refuted | refuted | refuted | refuted | refuted |

Nine of ten were judged, and every judgement was right. The one unjudged pass printed "unjudged (Codex error: Our servers are currently overloaded. Please try again later.)": the provider refused past the retries. The eval routes the judge to one model with no fallback, so an outage that outlasts the backoff still scores unjudged, and the printed reason now says so.

## What the run says about the lenses

- `reimplements-an-authority` found its seeded defect in every pass of both positive goldens, and stayed silent where no dependency covers the format.
- Under a stated gap that holds, the lens still tests the hand-written answer against the dependency, and found an input the golden's author had missed. A fixture meant to be clean under this rule has to be checked against the dependency itself.
- The verifier judged the unsupported gap confirmed and the supported one refuted whenever it judged.
- The `design` corpus's precision at a2793b71 was under the bar in pass two. One of its five extra findings there was the clean golden's, now fixed. At ace07815 the corpus clears both bars.

## Three passes at ace07815

From 21:18 to 22:27 by the run's own clock, one golden per invocation, with the same models. A cell reads reported findings, precision, recall. `design-injection` printed no score in pass two, so that pass counts 26 goldens.

| Golden | Expected | Pass 1 (reported, precision, recall) | Pass 2 | Pass 3 |
|---|---|---|---|---|
| `correctness-deleted-guard` | 2 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `correctness-deleted-rethrow` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `correctness-null-deref` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-bound-on-wrong-measure` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-bound-on-wrong-measure-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-decision-injection` | 2 | 1, 1.00, 0.50 | 2, 1.00, 1.00 | 2, 1.00, 1.00 |
| `design-fail-open-default` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-identity-missing-input` | 1 | 2, 0.50, 1.00 | 2, 0.50, 1.00 | 2, 0.50, 1.00 |
| `design-injection` | 2 | 3, 0.67, 1.00 | no score | 3, 0.67, 1.00 |
| `design-reimplements-an-authority` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-reimplements-an-authority-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-reimplements-an-authority-no-dependency-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-reimplements-an-authority-standard` | 1 | 1, 1.00, 1.00 | 0, 1.00, 0.00 | 1, 1.00, 1.00 |
| `design-reimplements-an-authority-unsupported-gap` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-resumed-identity` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-resumed-identity-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-rewrites-its-own-decision` | 1 | 1, 1.00, 1.00 | 2, 0.50, 1.00 | 2, 0.50, 1.00 |
| `design-single-slot-overwrite` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-single-slot-overwrite-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-superseded-at-base-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-supersedes-its-own-decision` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-terminology-change` | 1 | 2, 0.50, 1.00 | 2, 0.50, 1.00 | 2, 0.50, 1.00 |
| `design-terminology-change-in-design` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-trust-by-label` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-trust-by-label-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-unshipped-artifact` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |

The counts add before they divide, as above.

| Corpus | Pass | Goldens scored | Reported | True positives | Expected | Found | Precision | Recall |
|---|---|---|---|---|---|---|---|---|
| All 27 | 1 | 27 | 23 | 20 | 22 | 21 | 0.87 | 0.95 |
| All 27 | 2 | 26 | 21 | 18 | 20 | 19 | 0.86 | 0.95 |
| All 27 | 3 | 27 | 25 | 21 | 22 | 22 | 0.84 | 1.00 |
| `design` | 1 | 24 | 20 | 17 | 18 | 17 | 0.85 | 0.94 |
| `design` | 2 | 23 | 18 | 15 | 16 | 15 | 0.83 | 0.94 |
| `design` | 3 | 24 | 22 | 18 | 18 | 18 | 0.82 | 1.00 |
| `correctness` | 1 | 3 | 3 | 3 | 4 | 4 | 1.00 | 1.00 |
| `correctness` | 2 | 3 | 3 | 3 | 4 | 4 | 1.00 | 1.00 |
| `correctness` | 3 | 3 | 3 | 3 | 4 | 4 | 1.00 | 1.00 |

| Corpus | Worst precision | Mean precision | Worst recall | Mean recall |
|---|---|---|---|---|
| All 27 | 0.84 | 0.86 | 0.95 | 0.97 |
| `design` | 0.82 | 0.83 | 0.94 | 0.96 |
| `correctness` | 1.00 | 1.00 | 1.00 | 1.00 |

The guideline's bar is a worst precision of at least 0.8 and a worst recall of at least 0.6 over three passes, for a lens's goldens scored together.

- `design`: worst precision 0.82 and worst recall 0.94. It clears both bars. Its mean precision is 0.83 and its mean recall 0.96.
- `correctness`: precision and recall of 1.00 in every pass. It clears both bars, and the hand-off to `design` cost it nothing here.

The five authority goldens scored as expected in 14 of 15 runs. `design-reimplements-an-authority` and `design-reimplements-an-authority-unsupported-gap` were found in all three passes. `design-reimplements-an-authority-clean` and `design-reimplements-an-authority-no-dependency-clean` were clean in all three. `design-reimplements-an-authority-standard` was found in passes one and three and reported nothing in pass two.

The misses and extras:

- `design-reimplements-an-authority-standard`, pass two: nothing reported. Three more runs at ace07815 with `MELIAN_EVAL_SHOW=1` each reported the one expected finding, `quoted-rule-violation` at P3, confirmed. The miss did not recur, so its cause is not known. A refuted finding is left out of a run's count, so a verifier that refuted the `conventions` finding would print the same line as a lens that reported nothing; the score line cannot tell them apart. The lens text was not changed for one miss in seven runs.
- `design-decision-injection`, pass one: one of two expected findings.
- `design-injection`, pass two: no score. The line kept from the run is the tail of a Node stack trace. Three more runs at ace07815 each printed a score, 3 reported in one and 2 in two, so the error was not captured. The runner did not catch an error from a golden's review, such as every model of a tier failing, and such an error ends the process with that trace. The runner now prints `no score` with the error's message, goes on, and exits 1. The same golden printed no score in pass one at a2793b71.
- Extra sightings, as at a2793b71: `design-identity-missing-input` and `design-terminology-change` reported two for one expected in all three passes, `design-rewrites-its-own-decision` in passes two and three, and `design-injection` three for two in passes one and three. The first two have now done so in six passes of six across both runs. Adjudicated precision was not measured.

The verifier goldens were not rerun at ace07815; their five passes each at 8eeed1b1 stand.
