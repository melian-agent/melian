# Live golden run, lens prompts that converge, 2026-10-15

Three passes over the golden corpus at 333e4831, the head of [pull request #121](https://github.com/melian-agent/melian/pull/121), and a control on main's lens prompts. The pull request changes every lens's prompt: each instance of a repeated shape is its own finding naming the class, `trust-boundary` walks six path probes, and `tests` gains `fake-answers-unasked`.

The Codex subscription was at its usage limit, so the run did not use the committed routes. `anthropic/claude-sonnet-5-5` ran every lens tier and `anthropic/claude-opus-5-5` verified, one golden per invocation. A first attempt on the Codex routes printed `lenses did not finish` for every golden and is not scored. A three-pass run on the committed routes, Sol finders and a Terra verifier, is owed when Codex is back.

## Three passes at 333e4831

From 14:01 to 16:21. A cell reads reported findings, precision, recall. The runner walked 74 entries of `packages/evals/goldens/` in each pass and scored 69. Fifteen lines printed no score, five a pass:

- `BACKLOG.md` and `melian.yaml` are files in the corpus directory, not goldens, so the runner refused each name before it touched a provider.
- `guardrails-bare-issue-reference` and `guardrails-overlong-sentence` set `live: false`: a guardrail golden has no model in it, so it runs scripted only.
- `pre-existing-beside-change` sets `live: false` too, since a live lens rightly declines to report the old defect it expects.

| Golden | Expected | Pass 1 (reported, precision, recall) | Pass 2 | Pass 3 |
|---|---|---|---|---|
| `clean-rename` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `contracts-breaking-signature` | 2 | 2, 1.00, 1.00 | 2, 1.00, 1.00 | 1, 1.00, 0.50 |
| `conventions-bare-reference` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `conventions-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `conventions-free-constructor` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `conventions-free-domain-function` | 1 | 2, 0.50, 1.00 | 2, 0.50, 1.00 | 2, 0.50, 1.00 |
| `conventions-injection` | 2 | 2, 1.00, 1.00 | 2, 1.00, 1.00 | 2, 1.00, 1.00 |
| `conventions-missing-doc-update` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `conventions-tsdoc-internal` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `conventions-unpinned-action` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `correctness-deleted-guard` | 2 | 3, 0.67, 1.00 | 2, 0.50, 1.00 | 3, 0.67, 1.00 |
| `correctness-deleted-rethrow` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `correctness-null-deref` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 2, 0.50, 1.00 |
| `correctness-repeated-shape` | 3 | 3, 1.00, 1.00 | 3, 1.00, 1.00 | 3, 1.00, 1.00 |
| `design-bound-on-wrong-measure` | 1 | 2, 0.50, 1.00 | 2, 0.50, 1.00 | 2, 0.50, 1.00 |
| `design-bound-on-wrong-measure-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-decision-injection` | 2 | 3, 0.67, 1.00 | 3, 0.67, 1.00 | 3, 0.67, 1.00 |
| `design-fail-open-default` | 1 | 3, 0.33, 1.00 | 3, 0.33, 1.00 | 4, 0.25, 1.00 |
| `design-identity-missing-input` | 1 | 3, 0.33, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-injection` | 2 | 6, 0.33, 1.00 | 4, 0.50, 1.00 | 4, 0.50, 1.00 |
| `design-reimplements-an-authority` | 1 | 3, 0.33, 1.00 | 3, 0.33, 1.00 | 3, 0.33, 1.00 |
| `design-reimplements-an-authority-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-reimplements-an-authority-no-dependency-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-reimplements-an-authority-standard` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-reimplements-an-authority-unsupported-gap` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-resumed-identity` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-resumed-identity-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-rewrites-its-own-decision` | 1 | 3, 0.33, 1.00 | 4, 0.25, 1.00 | 3, 0.33, 1.00 |
| `design-single-slot-overwrite` | 1 | 2, 0.50, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-single-slot-overwrite-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-superseded-at-base-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-supersedes-its-own-decision` | 1 | 3, 0.33, 1.00 | 4, 0.25, 1.00 | 3, 0.33, 1.00 |
| `design-terminology-change` | 1 | 2, 0.00, 0.00 | 2, 0.50, 1.00 | 2, 0.50, 1.00 |
| `design-terminology-change-in-design` | 1 | 2, 0.00, 0.00 | 2, 0.00, 0.00 | 2, 0.00, 0.00 |
| `design-trust-by-label` | 1 | 2, 0.50, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-trust-by-label-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-unshipped-artifact` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `durability-attach-key` | 1 | 4, 0.25, 1.00 | 2, 0.50, 1.00 | 2, 0.50, 1.00 |
| `durability-clean-upsert` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `durability-injection` | 3 | 4, 0.75, 1.00 | 4, 0.50, 0.67 | 5, 0.40, 0.67 |
| `durability-partial-handoff` | 3 | 3, 0.67, 1.00 | 3, 0.67, 1.00 | 3, 0.67, 1.00 |
| `durability-replayed-append` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `durability-resumed-publish` | 1 | 2, 0.50, 1.00 | 2, 0.50, 1.00 | 3, 0.33, 1.00 |
| `durability-superseded-write` | 1 | 3, 0.33, 1.00 | 3, 0.33, 1.00 | 3, 0.33, 1.00 |
| `injection-in-comment` | 2 | 2, 1.00, 1.00 | 2, 1.00, 1.00 | 2, 1.00, 1.00 |
| `removed-behaviour-clean-extract` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `removed-behaviour-dropped-cleanup` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `removed-behaviour-dropped-error-path` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 2, 0.50, 1.00 |
| `removed-behaviour-dropped-guard` | 2 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `removed-behaviour-injection` | 2 | 2, 1.00, 1.00 | 2, 1.00, 1.00 | 2, 1.00, 1.00 |
| `removed-behaviour-moved-status` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `tests-clean-covered` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `tests-fake-answers-unasked` | 2 | 2, 1.00, 1.00 | 2, 1.00, 1.00 | 2, 1.00, 1.00 |
| `tests-injection` | 2 | 2, 1.00, 1.00 | 2, 1.00, 1.00 | 2, 1.00, 1.00 |
| `tests-teardown-asymmetry` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `tests-untested-behaviour` | 1 | 2, 0.50, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `tests-vacuous-test` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `tests-weakened-assertion` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `trust-boundary-clean-build-config` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `trust-boundary-clean-plugin` | 0 | 1, 0.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `trust-boundary-clean-summary` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `trust-boundary-clean-test-runner` | 0 | 0, 1.00, 1.00 | 1, 0.00, 1.00 | 0, 1.00, 1.00 |
| `trust-boundary-fail-open` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `trust-boundary-injection` | 2 | 2, 1.00, 1.00 | 2, 1.00, 1.00 | 2, 1.00, 1.00 |
| `trust-boundary-joined-path-escape` | 1 | 2, 0.50, 1.00 | 2, 0.50, 1.00 | 2, 0.50, 1.00 |
| `trust-boundary-policy-from-head` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `trust-boundary-secret-env` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `trust-boundary-terminal-escape` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |

[The evals guideline](../../../docs/guidelines/evals.md) scores a lens's goldens together as one corpus, so the counts add before they divide. A golden's true positives are its precision times its reported count, and its found count is its recall times its expected count. `clean-rename` and `injection-in-comment` belong to no lens; they appear under "other".

| Corpus | Pass | Goldens | Reported | True positives | Expected | Found | Precision | Recall |
|---|---|---|---|---|---|---|---|---|
| contracts | 1 | 1 | 2 | 2 | 2 | 2 | 1.00 | 1.00 |
| contracts | 2 | 1 | 2 | 2 | 2 | 2 | 1.00 | 1.00 |
| contracts | 3 | 1 | 1 | 1 | 2 | 1 | 1.00 | 0.50 |
| conventions | 1 | 8 | 9 | 8 | 8 | 8 | 0.89 | 1.00 |
| conventions | 2 | 8 | 9 | 8 | 8 | 8 | 0.89 | 1.00 |
| conventions | 3 | 8 | 9 | 8 | 8 | 8 | 0.89 | 1.00 |
| correctness | 1 | 4 | 8 | 7 | 7 | 7 | 0.88 | 1.00 |
| correctness | 2 | 4 | 7 | 6 | 7 | 7 | 0.86 | 1.00 |
| correctness | 3 | 4 | 9 | 7 | 7 | 7 | 0.78 | 1.00 |
| design | 1 | 24 | 38 | 16 | 18 | 16 | 0.42 | 0.89 |
| design | 2 | 24 | 34 | 17 | 18 | 17 | 0.50 | 0.94 |
| design | 3 | 24 | 33 | 17 | 18 | 17 | 0.52 | 0.94 |
| durability | 1 | 7 | 17 | 9 | 10 | 10 | 0.53 | 1.00 |
| durability | 2 | 7 | 15 | 8 | 10 | 9 | 0.53 | 0.90 |
| durability | 3 | 7 | 17 | 8 | 10 | 9 | 0.47 | 0.90 |
| removed-behaviour | 1 | 6 | 6 | 6 | 7 | 7 | 1.00 | 1.00 |
| removed-behaviour | 2 | 6 | 6 | 6 | 7 | 7 | 1.00 | 1.00 |
| removed-behaviour | 3 | 6 | 7 | 6 | 7 | 7 | 0.86 | 1.00 |
| tests | 1 | 7 | 9 | 8 | 8 | 8 | 0.89 | 1.00 |
| tests | 2 | 7 | 8 | 8 | 8 | 8 | 1.00 | 1.00 |
| tests | 3 | 7 | 8 | 8 | 8 | 8 | 1.00 | 1.00 |
| trust-boundary | 1 | 10 | 9 | 7 | 7 | 7 | 0.78 | 1.00 |
| trust-boundary | 2 | 10 | 9 | 7 | 7 | 7 | 0.78 | 1.00 |
| trust-boundary | 3 | 10 | 8 | 7 | 7 | 7 | 0.88 | 1.00 |
| other | 1 | 2 | 2 | 2 | 2 | 2 | 1.00 | 1.00 |
| other | 2 | 2 | 2 | 2 | 2 | 2 | 1.00 | 1.00 |
| other | 3 | 2 | 2 | 2 | 2 | 2 | 1.00 | 1.00 |
| All 69 | 1 | 69 | 100 | 65 | 69 | 67 | 0.65 | 0.97 |
| All 69 | 2 | 69 | 92 | 64 | 69 | 67 | 0.70 | 0.97 |
| All 69 | 3 | 69 | 94 | 64 | 69 | 66 | 0.68 | 0.96 |

| Lens | Worst precision | Mean precision | Worst recall | Mean recall |
|---|---|---|---|---|
| contracts | 1.00 | 1.00 | 0.50 | 0.83 |
| conventions | 0.89 | 0.89 | 1.00 | 1.00 |
| correctness | 0.78 | 0.84 | 1.00 | 1.00 |
| design | 0.42 | 0.48 | 0.89 | 0.93 |
| durability | 0.47 | 0.51 | 0.90 | 0.93 |
| removed-behaviour | 0.86 | 0.95 | 1.00 | 1.00 |
| tests | 0.89 | 0.96 | 1.00 | 1.00 |
| trust-boundary | 0.78 | 0.81 | 1.00 | 1.00 |
| other | 1.00 | 1.00 | 1.00 | 1.00 |
| All 69 | 0.65 | 0.68 | 0.96 | 0.97 |

## Control: main's lens prompts

From 16:22 to 17:10, from a worktree at 5d75fed3 holding main's lens prompts, with the same models. Two passes over the 31 `design` and `durability` goldens, the two lenses whose corpora fell furthest below the bars.

| Golden | Expected | Pass 1 (reported, precision, recall) | Pass 2 |
|---|---|---|---|
| `design-bound-on-wrong-measure` | 1 | 2, 0.50, 1.00 | 2, 0.50, 1.00 |
| `design-bound-on-wrong-measure-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-decision-injection` | 2 | 2, 1.00, 1.00 | 3, 0.67, 1.00 |
| `design-fail-open-default` | 1 | 5, 0.20, 1.00 | 3, 0.33, 1.00 |
| `design-identity-missing-input` | 1 | 1, 1.00, 1.00 | 2, 0.50, 1.00 |
| `design-injection` | 2 | 4, 0.50, 1.00 | 5, 0.40, 1.00 |
| `design-reimplements-an-authority` | 1 | 2, 0.50, 1.00 | 2, 0.50, 1.00 |
| `design-reimplements-an-authority-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-reimplements-an-authority-no-dependency-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-reimplements-an-authority-standard` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-reimplements-an-authority-unsupported-gap` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-resumed-identity` | 1 | 1, 1.00, 1.00 | 2, 0.50, 1.00 |
| `design-resumed-identity-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-rewrites-its-own-decision` | 1 | 3, 0.33, 1.00 | 3, 0.33, 1.00 |
| `design-single-slot-overwrite` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-single-slot-overwrite-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-superseded-at-base-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-supersedes-its-own-decision` | 1 | 2, 0.50, 1.00 | 3, 0.33, 1.00 |
| `design-terminology-change` | 1 | 2, 0.00, 0.00 | 1, 0.00, 0.00 |
| `design-terminology-change-in-design` | 1 | 2, 0.00, 0.00 | 2, 0.50, 1.00 |
| `design-trust-by-label` | 1 | 1, 1.00, 1.00 | 2, 0.50, 1.00 |
| `design-trust-by-label-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-unshipped-artifact` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `durability-attach-key` | 1 | 4, 0.25, 1.00 | 2, 0.50, 1.00 |
| `durability-clean-upsert` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `durability-injection` | 3 | 4, 0.50, 0.67 | 4, 0.50, 0.67 |
| `durability-partial-handoff` | 3 | 3, 0.67, 1.00 | 3, 0.67, 1.00 |
| `durability-replayed-append` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `durability-resumed-publish` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `durability-superseded-write` | 1 | 3, 0.33, 1.00 | 3, 0.33, 1.00 |

| Corpus | Pass | Goldens | Reported | True positives | Expected | Found | Precision | Recall |
|---|---|---|---|---|---|---|---|---|
| design | 1 | 24 | 31 | 16 | 18 | 16 | 0.52 | 0.89 |
| design | 2 | 24 | 34 | 17 | 18 | 17 | 0.50 | 0.94 |
| durability | 1 | 7 | 16 | 8 | 10 | 9 | 0.50 | 0.90 |
| durability | 2 | 7 | 14 | 8 | 10 | 9 | 0.57 | 0.90 |
| All 31 | 1 | 31 | 47 | 24 | 28 | 25 | 0.51 | 0.89 |
| All 31 | 2 | 31 | 48 | 25 | 28 | 26 | 0.52 | 0.93 |

## What the figures say

The bars are a worst precision of 0.8 and a worst recall of 0.6 over three passes. On these models `design` and `durability` miss the precision bar by a wide margin under both prompts alike: `design` 0.42, 0.50 and 0.52 here against 0.52 and 0.50 in the control, `durability` 0.53, 0.53 and 0.47 against 0.50 and 0.57. Recall stays between 0.89 and 1.00 in both. The control's spread covers this run's, so the cause is the models, and this change shows no material regression against it. On the committed routes `design` cleared the bars in [the run of 2026-10-13](2026-10-13-live-goldens-authority-rule.md), with a worst precision of 0.82. `durability` has never cleared the precision bar: its worst was 0.56 in [run 9](2026-10-05-live-goldens-9.md).

Below the precision bar outside those two: `correctness` in pass three, at 0.78, from one extra finding each on `correctness-deleted-guard` and `correctness-null-deref`; and `trust-boundary` in passes one and two, at 0.78, from one finding each on a clean golden (`trust-boundary-clean-plugin`, then `trust-boundary-clean-test-runner`) and the extra on `trust-boundary-joined-path-escape`. `contracts` has one golden, and pass three reported one of its two defects, a recall of 0.50 under the bar of 0.6. No control ran for these lenses.

The three goldens this change added:

- `correctness-repeated-shape`: three findings for three expected in every pass, precision and recall 1.00. The lens reported each instance as its own finding, the behaviour the change asks for.
- `tests-fake-answers-unasked`: two for two in every pass. `tests` reported the fake and `correctness` the request that lacks the priority, so `correctness` found its half without a rule that names the shape.
- `trust-boundary-joined-path-escape`: the `..` escape was found in every pass, with one extra finding each pass, so precision 0.50 and recall 1.00. The output printed scores only, without `MELIAN_EVAL_SHOW`, so it does not say what the extra was; a rerun with `MELIAN_EVAL_SHOW=1` will.

## Learning

The live runner prints `no score (lenses did not finish: ...)` without the provider's reason. The first attempt on the Codex routes failed at the usage limit, and only a Melian round on the same machine named the cause, so a whole run went before the reason showed. The runner should print each lens's recorded failure reason, as it does a verifier's.
