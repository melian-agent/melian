# Live golden run, reasoning levels, 2026-10-19

What does a higher reasoning level buy? [Pull request #157](https://github.com/melian-agent/melian/pull/157) lets a route set `thinking`, and [pull request #153](https://github.com/melian-agent/melian/pull/153)'s telemetry records the level each request body carried. This run compares levels on the three jobs that call a model: finding, triage and verification. Each cell scores a corpus per pass. A lens is judged by its worst pass, as [the evals guideline](../../../docs/guidelines/evals.md) requires: worst precision at least 0.8, worst recall at least 0.6.

## Cells

Every cell ran at `b10e7f67`, #157's head, except the pilot, which ran at `1ce6a7fd`. The runner took the level from `MELIAN_EVAL_THINKING`, for example `heavy=low,medium=low`. The telemetry line of every request names the level asked for and the level the body carried.

| Cell | Job | Model | Verifier | Levels | Passes |
|---|---|---|---|---|---|
| Sol | finder | `openai-codex/gpt-6.1-sol` | `anthropic/claude-sonnet-5-5` | low, medium, high | 2, over all 53 goldens |
| Opus | finder | `anthropic/claude-opus-5-5` | `openai-codex/gpt-5.6-terra` | low, high | 1, over correctness, design and durability |
| Terra | triage | `openai-codex/gpt-5.6-terra` | none | off, low, medium | 3, over 6 changes |
| Sonnet, Opus | verifier | each | none | low, high | 1, over 9 verifier goldens |

The Sol corpus holds correctness (5 goldens), design (24), durability (7), tests (7) and trust-boundary (10). All 212 Sol requests per level carried the requested level in the body (`requested=low effort=low observed`, and likewise for medium and high). The Opus telemetry reads `requested=low effort=high observed provider-reported=low`. Anthropic's managed-effort models open with `high` in the body, and the provider reports the level it applied, so the provider-reported level is the authority there. No invocation printed an unscored line.

## Finders

Each cell reads precision / recall for the worse of its passes. A corpus holds 7 to 18 expected findings, so one extra or missed finding moves a cell by 0.04 to 0.14.

| Corpus | Sol low | Sol medium | Sol high | Opus low | Opus high |
|---|---|---|---|---|---|
| Correctness | 1.00 / 1.00 | 0.86 / 1.00 | 1.00 / 1.00 | 0.86 / 1.00 | 0.86 / 1.00 |
| Design | 0.90 / 0.94 | 0.85 / 0.94 | 0.89 / 0.89 | 0.82 / 1.00 | 0.82 / 1.00 |
| Durability | 0.89 / 0.90 | 1.00 / 1.00 | 1.00 / 1.00 | 0.80 / 0.90 | 0.75 / 1.00 |
| Tests | 0.89 / 1.00 | 0.80 / 1.00 | 0.73 / 1.00 | | |
| Trust-boundary | 0.86 / 0.86 | 1.00 / 1.00 | 1.00 / 1.00 | | |

Pooled over the five corpora, each pass of Sol scores between 0.90 and 0.94 precision and between 0.96 and 1.00 recall, whatever the level.

Cost and time per golden, from the score lines:

| Cell | USD | Tokens | Seconds |
|---|---|---|---|
| Sol low | 0.126 | 111,000 | 32 |
| Sol medium | 0.139 | 114,000 | 38 |
| Sol high | 0.147 | 116,000 | 40 |
| Opus low | 0.254 | 115,000 | 37 |
| Opus high | 0.365 | 185,000 | 53 |

Costs are list-price equivalents; the runs used subscriptions.

## Triage

Terra answered triage's questions for 6 changes, 3 passes each. Exact is the share of choices equal to the maintainer's level.

| Level | Exact | Mean distance | Under-escalations |
|---|---|---|---|
| off | 0.75 | 0.25 | 0 |
| low | 0.83 | 0.17 | 0 |
| medium | 0.83 | 0.17 | 0 |

At off, Terra chose `careful` for `add-test-only` where the expected level is `quick`, in all three passes. At low and medium it chose `quick`. Both levels still chose `deep` for `retry-bound` and `shell-from-request` where the expected level is `careful`. Every error is an over-escalation, so none lowers a review's depth.

## Verifier

Sonnet and Opus each judged all 9 verifier goldens correctly at low and at high. The corpus does not tell the levels apart, so it gives no reason to change the verifier's level.

## What the evidence shows

More Sol reasoning did not improve precision. Pooled, the levels are within 0.02 of each other. Per corpus the signs differ: high is better on durability and trust-boundary, where low missed or added one finding in a pass, and worse on tests, where precision falls with the level (0.89, 0.80, 0.73) and high falls below the 0.8 bar. Recall is the same, 0.86 to 1.00 everywhere, with the one low miss being a single trust-boundary golden in pass 2. At low, a golden costs 14% less than at high and finishes 20% sooner.

Opus is no better a finder than Sol. At either level its precision is lower than Sol's on correctness, design and durability, and at high it falls below the bar on durability (0.75). It costs twice as much per golden, and its high level costs 44% more than its low level for no gain.

Triage gains from low. Off over-escalates a change that only adds a test, and low does not. Medium adds nothing over low.

## Limits

- Two passes of Sol, one of Opus, and corpora of 5 to 24 goldens per lens. A difference of one finding is inside the noise, so the table argues against a gain from reasoning more than it ranks the levels.
- No fresh Sol cell at the unset default level, by the maintainer's choice, so low is compared with medium and high only.
- The pilot cell, Sol medium on design, ran at `1ce6a7fd`, one pass, and scored 0.89 / 0.94. It is not in the table.
- The quick-level Terra lens was not measured: `MELIAN_EVAL_MODEL` routes every tier to one model, so the medium tier has no cell of its own.
- The verifier corpus does not discriminate.
- For managed-effort Anthropic models the observed opening effort reads `high` at every requested level. The provider-reported level is correct. The telemetry gap is a follow-up.
