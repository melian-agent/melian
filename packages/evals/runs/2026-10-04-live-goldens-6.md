# Live golden run 6, 2026-10-04

The first live runs of the four built-in backlog lenses, `trust-boundary`, `removed-behaviour`, `tests`, and `conventions`, on [pull request #42](https://github.com/melian-agent/melian/pull/42), over the twenty goldens it adds and the six before them. Three passes measured the lenses as first written; one tuning round followed, and three more passes measured it.

- Melian under test: the untuned passes ran with the code and lens files of `7f560ff`, and the tuned passes with those of `ed25da5`. The branch was rebased after each set of passes. The untuned passes ran before [pull request #43](https://github.com/melian-agent/melian/pull/43) reached `main`, and the tuned ones after it; that pull request adds a lint rule, a guardrail, and documents, and the later rebase only documents, none of which a lens run loads. The commits named here are the rebased ones, so they stay reachable. Both sit on `main` after [pull request #36](https://github.com/melian-agent/melian/pull/36), so `correctness` carries the declared-input rule. pi-ai 1.0.0 and Pi Durable 1.0.0.
- Lens versions, untuned: `correctness` `d7d338f575f0`, `contracts` `60e9cabb913b`, `trust-boundary` `30535f91dd40`, `removed-behaviour` `8ede5357acf5`, `tests` `e36f8e7cff9b`, `conventions` `33ad44be4f39`. Tuned: `correctness` `db4521c53845`, `trust-boundary` `37456558b6c7`, `removed-behaviour` `5f4872e0bbc1`; the other three unchanged.
- Model: `anthropic/claude-opus-5-5` for every tier, through `MELIAN_EVAL_MODEL`. Every lens runs at `careful`, on `heavy`.
- Credentials: an Anthropic OAuth token in `CLAUDE_CODE_OAUTH_TOKEN`, loaded with `node --env-file` on the built packages.

## Method

Each measurement is three passes of the documented runner, one after another:

```bash
npm run build
MELIAN_EVAL_LIVE=1 MELIAN_EVAL_MODEL=anthropic/claude-opus-5-5 node --env-file=<env file> packages/evals/src/live.ts
```

`live.ts` prints scores only, so each set of three passes was followed by one logged pass over every golden, through a helper like [the second run's](2026-10-03-live-goldens-2.md#method): it calls `runGolden` and `scoreGolden` from the built package, unwraps the models handle with the pipeline's internal `modelsOf`, and rewraps it with `wrapModels` around a proxy that records each `streamSimple` request's lens, usage, tool calls, and final text. It also records each finding's source lens, which is what attributes an extra to the lens that drew it. The logged pass is a fourth draw, not one of the three, so the tables below come from `live.ts` and the attribution from the logged pass.

Scoring matches on file and rule, per golden. "A lens's goldens" are the five whose names start with its name; their precision and recall are micro-averaged over the five, and count every lens's findings, since the golden scores the whole review. A second table attributes each finding to the lens that reported it, over the whole corpus. `pre-existing-beside-change` sets `live: false` and is skipped.

One golden changed between the two measurements, and one gained an expectation, both for reasons the untuned pass exposed; [below](#goldens-changed-between-the-measurements) says why.

## Results, untuned

Per golden, over three passes:

| Golden | Expected | Reported | Precision worst | Precision mean | Recall worst | Recall mean |
| --- | --- | --- | --- | --- | --- | --- |
| `clean-rename` | 0 | 0, 0, 0 | 1.00 | 1.00 | 1.00 | 1.00 |
| `contracts-breaking-signature` | 2 | 3, 2, 2 | 0.50 | 0.72 | 0.50 | 0.83 |
| `conventions-bare-reference` | 1 | 2, 2, 2 | 0.50 | 0.50 | 1.00 | 1.00 |
| `conventions-clean` | 0 | 0, 0, 1 | 0.00 | 0.67 | 1.00 | 1.00 |
| `conventions-missing-doc-update` | 1 | 2, 2, 2 | 0.50 | 0.50 | 1.00 | 1.00 |
| `conventions-tsdoc-internal` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `conventions-unpinned-action` | 1 | 2, 2, 1 | 0.50 | 0.67 | 1.00 | 1.00 |
| `correctness-deleted-guard` | 2 | 2, 2, 2 | 1.00 | 1.00 | 1.00 | 1.00 |
| `correctness-null-deref` | 1 | 2, 2, 2 | 0.50 | 0.50 | 1.00 | 1.00 |
| `injection-in-comment` | 2 | 2, 2, 2 | 1.00 | 1.00 | 1.00 | 1.00 |
| `removed-behaviour-clean-extract` | 0 | 0, 0, 0 | 1.00 | 1.00 | 1.00 | 1.00 |
| `removed-behaviour-dropped-cleanup` | 1 | 2, 2, 2 | 0.50 | 0.50 | 1.00 | 1.00 |
| `removed-behaviour-dropped-error-path` | 1 | 3, 3, 3 | 0.33 | 0.33 | 1.00 | 1.00 |
| `removed-behaviour-dropped-guard` | 1 | 2, 2, 2 | 0.50 | 0.50 | 1.00 | 1.00 |
| `removed-behaviour-moved-status` | 1 | 3, 3, 3 | 0.33 | 0.33 | 1.00 | 1.00 |
| `tests-clean-covered` | 0 | 1, 1, 1 | 0.00 | 0.00 | 1.00 | 1.00 |
| `tests-teardown-asymmetry` | 1 | 2, 2, 2 | 0.50 | 0.50 | 1.00 | 1.00 |
| `tests-untested-behaviour` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `tests-vacuous-test` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `tests-weakened-assertion` | 1 | 4, 4, 4 | 0.25 | 0.25 | 1.00 | 1.00 |
| `trust-boundary-clean-summary` | 0 | 0, 0, 0 | 1.00 | 1.00 | 1.00 | 1.00 |
| `trust-boundary-fail-open` | 1 | 3, 3, 3 | 0.33 | 0.33 | 1.00 | 1.00 |
| `trust-boundary-policy-from-head` | 1 | 3, 3, 3 | 0.00 | 0.00 | 0.00 | 0.00 |
| `trust-boundary-secret-env` | 1 | 2, 2, 2 | 0.50 | 0.50 | 1.00 | 1.00 |
| `trust-boundary-terminal-escape` | 1 | 2, 2, 2 | 0.50 | 0.50 | 1.00 | 1.00 |

Per lens's goldens and for the corpus:

| Goldens | Precision per pass | Worst | Mean | Recall per pass | Worst | Mean |
| --- | --- | --- | --- | --- | --- | --- |
| `trust-boundary-*` | 0.30, 0.30, 0.30 | 0.30 | 0.30 | 0.75, 0.75, 0.75 | 0.75 | 0.75 |
| `removed-behaviour-*` | 0.40, 0.40, 0.40 | 0.40 | 0.40 | 1.00, 1.00, 1.00 | 1.00 | 1.00 |
| `tests-*` | 0.44, 0.44, 0.44 | 0.44 | 0.44 | 1.00, 1.00, 1.00 | 1.00 | 1.00 |
| `conventions-*` | 0.57, 0.57, 0.57 | 0.57 | 0.57 | 1.00, 1.00, 1.00 | 1.00 | 1.00 |
| Corpus | 0.49, 0.48, 0.50 | 0.48 | 0.49 | 0.96, 0.91, 0.96 | 0.91 | 0.94 |

Every lens fell below the 0.8 precision bar on its goldens; none fell below 0.6 recall.

### Who drew the extras

From the untuned logged pass, by the lens that reported each finding, over the whole corpus:

| Lens | Reported | Matched | Extra | Precision | Expected | Found | Recall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `correctness` | 14 | 5 | 9 | 0.36 | 5 | 5 | 1.00 |
| `contracts` | 3 | 2 | 1 | 0.67 | 1 | 1 | 1.00 |
| `trust-boundary` | 8 | 4 | 4 | 0.50 | 4 | 4 | 1.00 |
| `removed-behaviour` | 11 | 5 | 6 | 0.45 | 5 | 5 | 1.00 |
| `tests` | 5 | 4 | 1 | 0.80 | 4 | 4 | 1.00 |
| `conventions` | 4 | 4 | 0 | 1.00 | 4 | 4 | 1.00 |

Each new lens found its own defect on all of its goldens, and `conventions` reported nothing else anywhere. Nearly every extra was a second or third report of a defect another lens owns, at the same file and usually the same line:

- `correctness` filed nine of them, on every lens's goldens: the dropped `finally` as `state-ordering`, the swallowed read error as `unhandled-error`, the moved status as `state-ordering`, the teardown and the weakened assertion in test files, and the fail-open skip, the policy read, and the raw path as `wrong-result`. Nothing in its body told it the new lenses existed.
- `removed-behaviour` filed six, on lines where something was replaced rather than lost: the `?? "none"` fallback that `correctness-null-deref`'s cast replaced, the rounding rule `conventions-missing-doc-update` changed on purpose, the base-commit policy read, the deleted `env` option, a test's filter, and the fail-open early return, where nothing was deleted at all.
- `trust-boundary` filed four, each a `fail-open` or `head-controls-judge` resting on an attacker it inferred: "Inferred: the caller passes the checkout of the revision being reviewed as `root`" for the swallowed read error; "inferred: it quotes or describes content the head controls" for the refused review; a weakened test; and the unpinned `actions/cache@v4`, argued from the tj-actions incident.
- `tests` filed one, and it was right: `tests-clean-covered` had no test where `drop` equals `accept`, so `>` could become `>=` and every test would pass. The golden was not clean.
- `contracts` filed `data-contract` on `docs/design.md` for the rounding change, the same defect `conventions` reports as `missing-doc-update`.

`trust-boundary-policy-from-head` scored recall 0 in all three passes, each with three findings and none on `src/policy.ts`, while the logged pass found it there. The tuned logged pass shows where the misses go: `trust-boundary` reports the policy read at `src/review.ts:9`, where `verdict` reads the policy from the head's checkout, and the golden expects `src/policy.ts`, where the file is read.

## The tuning round

Hypothesis: the precision lost is ownership, not judgement. Each lens finds the defect its goldens seed, and most extras restate a neighbour's finding because the boundaries were written on one side only: the new lenses said what to leave to `correctness`, and `correctness` said nothing back. Stating each boundary on both sides, and giving `removed-behaviour` and `trust-boundary` a test they can apply before reporting, should remove the duplicates without costing recall.

The changes, in `ed25da5`:

- `removed-behaviour` checks, before it reports, that something was deleted or moved, that the replacement line is not itself wrong, that the change did not set out to replace the behaviour, that the deleted line did not stand on a trust boundary, and that it was not in a test.
- `trust-boundary` needs the code it read to say who controls a hostile input; an inferred step can never be the one that makes the input hostile. A failure nobody arranges is not hostile input, a test is not a boundary, and a loosely pinned dependency is hygiene for the standards or a static rule.
- `correctness` hands a deleted cleanup, error path, or ordering to `removed-behaviour`, hostile input to `trust-boundary`, and a test's defect to `tests`.

`correctness` is not one of the four lenses, but most extras were its, and a boundary only one side states does not hold. A removed guard stays with both: [pull request #36](https://github.com/melian-agent/melian/pull/36) taught `correctness` that a removed guard declares the inputs it rejected.

### Goldens changed between the measurements

- `tests-clean-covered` gained the boundary test the untuned `tests` lens asked for, `parseBand({ drop: 0.5, accept: 0.5 })`. Its extra was a real gap, so the golden was wrong, not the lens.
- `removed-behaviour-dropped-guard` now expects `correctness`'s `wrong-result` beside `dropped-guard`. `correctness` reported the hang in all four untuned draws, and its instructions now claim a removed guard, so under the rule [the evals guideline](../../../docs/guidelines/evals.md#adding-a-golden) states it is a real finding, not an extra.

## Results, tuned

Per golden, over three passes:

| Golden | Expected | Reported | Precision worst | Precision mean | Recall worst | Recall mean |
| --- | --- | --- | --- | --- | --- | --- |
| `clean-rename` | 0 | 0, 0, 0 | 1.00 | 1.00 | 1.00 | 1.00 |
| `contracts-breaking-signature` | 2 | 2, 2, 2 | 1.00 | 1.00 | 1.00 | 1.00 |
| `conventions-bare-reference` | 1 | 2, 2, 2 | 0.50 | 0.50 | 1.00 | 1.00 |
| `conventions-clean` | 0 | 0, 0, 0 | 1.00 | 1.00 | 1.00 | 1.00 |
| `conventions-missing-doc-update` | 1 | 2, 2, 2 | 0.50 | 0.50 | 1.00 | 1.00 |
| `conventions-tsdoc-internal` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `conventions-unpinned-action` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `correctness-deleted-guard` | 2 | 1, 2, 2 | 1.00 | 1.00 | 0.50 | 0.83 |
| `correctness-null-deref` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `injection-in-comment` | 2 | 2, 2, 2 | 1.00 | 1.00 | 1.00 | 1.00 |
| `removed-behaviour-clean-extract` | 0 | 0, 0, 0 | 1.00 | 1.00 | 1.00 | 1.00 |
| `removed-behaviour-dropped-cleanup` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `removed-behaviour-dropped-error-path` | 1 | 2, 2, 2 | 0.50 | 0.50 | 1.00 | 1.00 |
| `removed-behaviour-dropped-guard` | 2 | 2, 2, 2 | 1.00 | 1.00 | 1.00 | 1.00 |
| `removed-behaviour-moved-status` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `tests-clean-covered` | 0 | 0, 0, 0 | 1.00 | 1.00 | 1.00 | 1.00 |
| `tests-teardown-asymmetry` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `tests-untested-behaviour` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `tests-vacuous-test` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `tests-weakened-assertion` | 1 | 2, 2, 2 | 0.50 | 0.50 | 1.00 | 1.00 |
| `trust-boundary-clean-summary` | 0 | 0, 0, 0 | 1.00 | 1.00 | 1.00 | 1.00 |
| `trust-boundary-fail-open` | 1 | 2, 2, 1 | 0.50 | 0.67 | 1.00 | 1.00 |
| `trust-boundary-policy-from-head` | 1 | 1, 1, 1 | 0.00 | 0.33 | 0.00 | 0.33 |
| `trust-boundary-secret-env` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `trust-boundary-terminal-escape` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |

Per lens's goldens and for the corpus:

| Goldens | Precision per pass | Worst | Mean | Recall per pass | Worst | Mean |
| --- | --- | --- | --- | --- | --- | --- |
| `trust-boundary-*` | 0.60, 0.60, 1.00 | 0.60 | 0.73 | 0.75, 0.75, 1.00 | 0.75 | 0.83 |
| `removed-behaviour-*` | 0.83, 0.83, 0.83 | 0.83 | 0.83 | 1.00, 1.00, 1.00 | 1.00 | 1.00 |
| `tests-*` | 0.80, 0.80, 0.80 | 0.80 | 0.80 | 1.00, 1.00, 1.00 | 1.00 | 1.00 |
| `conventions-*` | 0.67, 0.67, 0.67 | 0.67 | 0.67 | 1.00, 1.00, 1.00 | 1.00 | 1.00 |
| Corpus | 0.79, 0.79, 0.86 | 0.79 | 0.81 | 0.92, 0.96, 1.00 | 0.92 | 0.96 |

From the tuned logged pass, by lens:

| Lens | Reported | Matched | Extra | Precision | Expected | Found | Recall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `correctness` | 8 | 5 | 3 | 0.62 | 5 | 5 | 1.00 |
| `contracts` | 4 | 2 | 2 | 0.50 | 1 | 1 | 1.00 |
| `trust-boundary` | 5 | 3 | 2 | 0.60 | 4 | 3 | 0.75 |
| `removed-behaviour` | 6 | 5 | 1 | 0.83 | 5 | 5 | 1.00 |
| `tests` | 4 | 4 | 0 | 1.00 | 4 | 4 | 1.00 |
| `conventions` | 4 | 4 | 0 | 1.00 | 4 | 4 | 1.00 |

The hypothesis held. Corpus precision rose from a mean of 0.49 to 0.81 and recall held at 0.96. Extras fell from 21 to 8 in the logged pass, and the new lenses drew three of them, down from eleven. `removed-behaviour` cleared both bars on its goldens, and `tests` sits on the precision bar at 0.80 with no extra of its own. `correctness-deleted-guard` lost `removed-behaviour`'s `dropped-guard` in one pass of three, the only recall the tuning cost.

## What remains

The round is spent; these stay open.

- `trust-boundary` is below the precision bar on its goldens, at 0.60 worst and 0.73 mean, and its recall is 0.75 in two passes. Both come from one golden: on `trust-boundary-policy-from-head` the lens reports the defect at `src/review.ts:9`, where `verdict` reads the policy from the head's checkout, rather than at `src/policy.ts`, where the file is read. The finding is right and the file is a defensible choice, so the miss is scoring by file meeting a defect that spans two; the golden expects the read, and I left it so. The other extra is `correctness`'s `wrong-result` on the fail-open skip in two passes of three.
- `conventions` is below the bar at 0.67, with no extra of its own. On `conventions-bare-reference`, `correctness` reports that `count` counts an item priced at 0.4 cents, though the design says prices are whole cents. On `conventions-missing-doc-update`, `contracts` reports the stale design document as `data-contract`, because its own definition counts documented behaviour as a contract. Either needs a change to a lens this pull request did not set out to change, `contracts`, or a `correctness` rule against inputs the design rules out.
- `tests-weakened-assertion` still draws `contracts`' `data-contract` on the narrowed test and, in the logged pass, `trust-boundary`'s `head-controls-judge` on the skill's new `git fetch origin`, which the tuned lens should leave to the tests lens.
- `contracts-breaking-signature` drew `removed-behaviour`'s `dropped-guard` on the old `$` formatting in the logged pass, though not in the three passes: a replaced behaviour the lens's new check should drop.
- `removed-behaviour-dropped-error-path` still draws `correctness`'s `unhandled-error`, though `correctness` now hands deleted error paths to `removed-behaviour`. The swallowing `catch` is both a deleted rethrow and a line the change wrote, so the handoff reads both ways. A rule alias between `dropped-error-path` and `unhandled-error` would merge the two for the author; it would not change the score.
- Cost: the untuned logged pass made 422 requests in 525 s for about 117,000 output tokens, $5.70 at list price; the tuned one, 397 requests in 459 s for about 101,000, $5.26. An OAuth subscription is not billed per token.
