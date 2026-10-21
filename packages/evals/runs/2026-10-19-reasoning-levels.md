# Live golden run, reasoning levels, 2026-10-19

What does a higher reasoning level buy? [Pull request #157](https://github.com/melian-agent/melian/pull/157) lets a route set `thinking`, and [pull request #153](https://github.com/melian-agent/melian/pull/153)'s telemetry records the level each request body carried. This run compares levels on the three jobs that call a model: finding, triage and verification. Each cell scores a corpus per pass. A lens is judged by its worst pass, as [the evals guideline](../../../docs/guidelines/evals.md) requires: worst precision at least 0.8, worst recall at least 0.6.

## Cells

Every cell ran at `b10e7f67`, #157's head, except the pilot, which ran at `1ce6a7fd` and is not scored here. The runner took the level from `MELIAN_EVAL_THINKING`, for example `heavy=low,medium=low`. The telemetry line of every request names the level asked for and the level the body carried.

| Cell | Job | Model | Verifier | Levels | Passes | Corpora |
|---|---|---|---|---|---|---|
| Sol | finder | `openai-codex/gpt-6.1-sol` | `anthropic/claude-sonnet-5-5` | low, medium | 3 | all eight heavy lenses, 68 goldens |
| Sol | finder | same | same | high | 2 | the first five lenses, 53 goldens |
| Opus | finder | `anthropic/claude-opus-5-5` | `openai-codex/gpt-5.6-terra` | low | 3 | correctness, design, durability, 36 goldens |
| Opus | finder | same | same | high | 1 | same |
| Terra | triage | `openai-codex/gpt-5.6-terra` | none | off, low, medium | 3, over 6 changes | |
| Sonnet, Opus | verifier | each | none | low, high | 1, over 9 verifier goldens | |

The eight corpora are correctness (5 goldens), design (24), durability (7), tests (7), trust-boundary (10), contracts (1), removed-behaviour (6) and conventions (8). Every Sol score line shows the body carrying the requested level (`requested=low effort=low observed`, and likewise for medium and high). The Opus telemetry reads `requested=low effort=high observed provider-reported=low`. Anthropic's managed-effort models open with `high` in the body, and the provider reports the level it applied, so the provider-reported level is the authority there. No invocation printed an unscored line.

Sol low and medium passes 1 and 2 over the first five corpora, and Opus low pass 1, come from the first run. Pass 3 over those corpora, and passes 1 to 3 over contracts, removed-behaviour and conventions, come from an extension run on the same build. Opus low passes 2 and 3 are a second extension, renumbered.

## Finders

Each table row is a corpus. A pass cell reads: reported findings, true positives, expected findings, expected findings found; then precision / recall. The rule is `scoreCorpus`'s: precision is true positives over reported, recall is found over expected, each summed over the corpus's goldens. A corpus with nothing reported has precision 1. The bars are worst precision at least 0.8 and worst recall at least 0.6. "All corpora" sums the counts across the cell's corpora.

#### Sol low

| Corpus | Goldens | Pass 1 (rep, TP, exp, found: P / R) | Pass 2 (rep, TP, exp, found: P / R) | Pass 3 (rep, TP, exp, found: P / R) | Worst P / R | Mean P / R |
|---|---|---|---|---|---|---|
| correctness | 5 | 6, 6, 7, 7: 1.00 / 1.00 | 6, 6, 7, 7: 1.00 / 1.00 | 6, 6, 7, 7: 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| design | 24 | 20, 18, 18, 18: 0.90 / 1.00 | 18, 17, 18, 17: 0.94 / 0.94 | 18, 16, 18, 16: 0.89 / 0.89 | 0.89 / 0.89 | 0.91 / 0.94 |
| durability | 7 | 9, 8, 10, 9: 0.89 / 0.90 | 9, 9, 10, 10: 1.00 / 1.00 | 9, 9, 10, 10: 1.00 / 1.00 | 0.89 / 0.90 | 0.96 / 0.97 |
| tests | 7 | 9, 8, 8, 8: 0.89 / 1.00 | 9, 8, 8, 8: 0.89 / 1.00 | 10, 8, 8, 8: 0.80 / 1.00 | 0.80 / 1.00 | 0.86 / 1.00 |
| trust-boundary | 10 | 7, 7, 7, 7: 1.00 / 1.00 | 7, 6, 7, 6: 0.86 / 0.86 | 7, 7, 7, 7: 1.00 / 1.00 | 0.86 / 0.86 | 0.95 / 0.95 |
| contracts | 1 | 1, 1, 2, 1: 1.00 / 0.50 | 1, 1, 2, 1: 1.00 / 0.50 | 1, 1, 2, 1: 1.00 / 0.50 | 1.00 / 0.50 | 1.00 / 0.50 |
| removed-behaviour | 6 | 6, 6, 7, 6: 1.00 / 0.86 | 6, 6, 7, 7: 1.00 / 1.00 | 6, 6, 7, 7: 1.00 / 1.00 | 1.00 / 0.86 | 1.00 / 0.95 |
| conventions | 8 | 8, 8, 8, 8: 1.00 / 1.00 | 8, 8, 8, 8: 1.00 / 1.00 | 8, 8, 8, 8: 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| All corpora | 68 | 66, 62, 67, 64: 0.94 / 0.96 | 64, 61, 67, 64: 0.95 / 0.96 | 65, 61, 67, 64: 0.94 / 0.96 | 0.94 / 0.96 | 0.94 / 0.96 |

#### Sol medium

| Corpus | Goldens | Pass 1 (rep, TP, exp, found: P / R) | Pass 2 (rep, TP, exp, found: P / R) | Pass 3 (rep, TP, exp, found: P / R) | Worst P / R | Mean P / R |
|---|---|---|---|---|---|---|
| correctness | 5 | 7, 6, 7, 7: 0.86 / 1.00 | 7, 7, 7, 7: 1.00 / 1.00 | 6, 6, 7, 7: 1.00 / 1.00 | 0.86 / 1.00 | 0.95 / 1.00 |
| design | 24 | 20, 18, 18, 18: 0.90 / 1.00 | 20, 17, 18, 17: 0.85 / 0.94 | 22, 18, 18, 18: 0.82 / 1.00 | 0.82 / 0.94 | 0.86 / 0.98 |
| durability | 7 | 9, 9, 10, 10: 1.00 / 1.00 | 9, 9, 10, 10: 1.00 / 1.00 | 9, 9, 10, 10: 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| tests | 7 | 10, 8, 8, 8: 0.80 / 1.00 | 10, 8, 8, 8: 0.80 / 1.00 | 9, 8, 8, 8: 0.89 / 1.00 | 0.80 / 1.00 | 0.83 / 1.00 |
| trust-boundary | 10 | 7, 7, 7, 7: 1.00 / 1.00 | 7, 7, 7, 7: 1.00 / 1.00 | 7, 7, 7, 7: 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| contracts | 1 | 1, 1, 2, 1: 1.00 / 0.50 | 1, 1, 2, 1: 1.00 / 0.50 | 1, 1, 2, 1: 1.00 / 0.50 | 1.00 / 0.50 | 1.00 / 0.50 |
| removed-behaviour | 6 | 6, 6, 7, 7: 1.00 / 1.00 | 6, 6, 7, 7: 1.00 / 1.00 | 6, 6, 7, 7: 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| conventions | 8 | 9, 8, 8, 8: 0.89 / 1.00 | 8, 8, 8, 8: 1.00 / 1.00 | 8, 8, 8, 8: 1.00 / 1.00 | 0.89 / 1.00 | 0.96 / 1.00 |
| All corpora | 68 | 69, 63, 67, 66: 0.91 / 0.99 | 68, 63, 67, 65: 0.93 / 0.97 | 68, 63, 67, 66: 0.93 / 0.99 | 0.91 / 0.97 | 0.92 / 0.98 |

#### Opus low

| Corpus | Goldens | Pass 1 (rep, TP, exp, found: P / R) | Pass 2 (rep, TP, exp, found: P / R) | Pass 3 (rep, TP, exp, found: P / R) | Worst P / R | Mean P / R |
|---|---|---|---|---|---|---|
| correctness | 5 | 7, 6, 7, 7: 0.86 / 1.00 | 7, 6, 7, 7: 0.86 / 1.00 | 6, 6, 7, 7: 1.00 / 1.00 | 0.86 / 1.00 | 0.90 / 1.00 |
| design | 24 | 22, 18, 18, 18: 0.82 / 1.00 | 24, 18, 18, 18: 0.75 / 1.00 | 20, 17, 18, 17: 0.85 / 0.94 | 0.75 / 0.94 | 0.81 / 0.98 |
| durability | 7 | 10, 8, 10, 9: 0.80 / 0.90 | 9, 8, 10, 9: 0.89 / 0.90 | 10, 8, 10, 9: 0.80 / 0.90 | 0.80 / 0.90 | 0.83 / 0.90 |
| All corpora | 36 | 39, 32, 35, 34: 0.82 / 0.97 | 40, 32, 35, 34: 0.80 / 0.97 | 36, 31, 35, 33: 0.86 / 0.94 | 0.80 / 0.94 | 0.83 / 0.96 |

#### Sol high

| Corpus | Goldens | Pass 1 (rep, TP, exp, found: P / R) | Pass 2 (rep, TP, exp, found: P / R) | Worst P / R | Mean P / R |
|---|---|---|---|---|---|
| correctness | 5 | 6, 6, 7, 7: 1.00 / 1.00 | 6, 6, 7, 7: 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| design | 24 | 18, 16, 18, 16: 0.89 / 0.89 | 20, 18, 18, 18: 0.90 / 1.00 | 0.89 / 0.89 | 0.89 / 0.94 |
| durability | 7 | 9, 9, 10, 10: 1.00 / 1.00 | 9, 9, 10, 10: 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| tests | 7 | 11, 8, 8, 8: 0.73 / 1.00 | 10, 8, 8, 8: 0.80 / 1.00 | 0.73 / 1.00 | 0.76 / 1.00 |
| trust-boundary | 10 | 7, 7, 7, 7: 1.00 / 1.00 | 7, 7, 7, 7: 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| All corpora | 53 | 51, 46, 50, 48: 0.90 / 0.96 | 52, 48, 50, 50: 0.92 / 1.00 | 0.90 / 0.96 | 0.91 / 0.98 |

#### Opus high

| Corpus | Goldens | Pass 1 (rep, TP, exp, found: P / R) | Worst P / R | Mean P / R |
|---|---|---|---|---|
| correctness | 5 | 7, 6, 7, 7: 0.86 / 1.00 | 0.86 / 1.00 | 0.86 / 1.00 |
| design | 24 | 22, 18, 18, 18: 0.82 / 1.00 | 0.82 / 1.00 | 0.82 / 1.00 |
| durability | 7 | 12, 9, 10, 10: 0.75 / 1.00 | 0.75 / 1.00 | 0.75 / 1.00 |
| All corpora | 36 | 41, 33, 35, 35: 0.80 / 1.00 | 0.80 / 1.00 | 0.80 / 1.00 |

Sol high and Opus high are marked as fewer passes: two passes on five corpora, and one pass on three. They are not three-pass results and carry no weight in the decision.

Cost and time per golden, from the score lines. The first column of each pair covers the cell's own goldens; the five-corpus column covers the 53 goldens every Sol cell ran, so high is comparable.

| Cell | USD | Tokens | Seconds | USD, five corpora | Seconds, five corpora |
|---|---|---|---|---|---|
| Sol low | 0.121 | 107,000 | 32 | 0.127 | 32 |
| Sol medium | 0.129 | 109,000 | 35 | 0.136 | 37 |
| Sol high (2 passes) | 0.147 | 116,000 | 40 | 0.147 | 40 |
| Opus low | 0.255 | 117,000 | 35 | 0.255 | 35 |
| Opus high (1 pass) | 0.365 | 185,000 | 53 | 0.365 | 53 |

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

- Low and medium both clear the precision bar on every lens over three passes. Worst precision is 0.80 for both, on tests, at the bar's edge; every other lens sits at 0.82 or above.
- Low and medium are the same quality. Over all corpora Sol low scores 0.94 mean precision and 0.96 mean recall, Sol medium 0.92 and 0.98. Each wins some lenses by one finding in a pass: low on design (0.91 against 0.86), tests and conventions; medium on trust-boundary and durability. Medium's worst design precision is 0.82 where low's is 0.89. Low costs 6% less and finishes 10% sooner.
- Contracts recall is 0.50 at both levels, in all three passes. That is below the 0.6 bar and does not move with the level. The corpus is one golden with two expected findings, and both levels find the same one, so the miss is the lens's or the golden's, not the reasoning level's.
- Sol high, on two passes, scored tests precision 0.73, below the bar, and no better elsewhere. It adds cost and gives no sign of a gain. This is the weaker evidence of the three, and the decision does not rest on it.
- Opus is no better a finder than Sol. At low its worst precision is lower than Sol low's on correctness (0.86 against 1.00), design (0.75 against 0.89) and durability (0.80 against 0.89). Its design precision falls below the 0.8 bar in pass 2 (0.75). It costs twice as much per golden.

Opus low is the heavy tier's first fallback. The level applies per tier, fallbacks included, so a review that fails over from Sol to Opus runs Opus at low and meets design at a worst precision of 0.75. Opus at high measured 0.82 on design and 0.75 on durability in one pass, so a higher level is not shown to repair it. This is a stated limit of the decision.

## Limits

- Three passes for Sol low, Sol medium and Opus low. Corpora hold 1 to 24 goldens, so one finding moves a cell by 0.04 to 0.14, and contracts holds one golden.
- Sol high and Opus high have fewer passes, as marked.
- `openai/gpt-5.5`, the heavy tier's second fallback, is unmeasured: no credential was available.
- No fresh Sol cell at the unset default level, by the maintainer's choice, so low is compared with medium and high only.
- The quick-level Terra lens was not measured: `MELIAN_EVAL_MODEL` routes every tier to one model, so the medium tier has no cell of its own.
- The verifier corpus does not discriminate.
- The walkthrough, which a light route turns on, was not measured. The maintainer decided to keep it.
- For managed-effort Anthropic models the observed opening effort reads `high` at every requested level. The provider-reported level is correct. The telemetry gap is a follow-up.
