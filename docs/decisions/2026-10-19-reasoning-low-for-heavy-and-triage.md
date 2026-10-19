# Low reasoning for the heavy tier and for triage

Status: accepted for milestone 2, step 33.

Amends: [2026-10-19-tier-thinking-routes.md](2026-10-19-tier-thinking-routes.md), which left every committed level unset until measurements chose defaults. The contract, identities and stored versions it records stand.

## Problem

A route can now set a reasoning level, and Melian's committed routes left every level to Pi's default. A default is not a measurement: Pi's unset level means no reasoning for Terra and a provider default for Sol.

[The reasoning-levels run](../../packages/evals/runs/2026-10-19-reasoning-levels.md) measured the levels, each observed in the request body. For Sol on the heavy tier, high reasoning did not raise precision. Pooled over five corpora, the levels sit within 0.02 of one another, and tests precision falls as the level rises (0.89, 0.80, 0.73). Low costs 14% less than high and finishes 20% sooner. For triage on Terra, low raises exact agreement from 0.75 to 0.83 with no under-escalation, and medium adds nothing.

## Choice

`melian.yaml` commits `thinking: low` on two routes:

- `models.heavy`, which runs the `careful` and `deep` lens levels. The run is the evidence for Sol; the fallbacks Opus and GPT-5.5 take the same level, as the tier decision says, and Opus measured no better at low than at high.
- `models.light`, which triage reads. Today no committed route names a light tier, and triage takes the first of light, medium and heavy that routes a model, so it resolves to the medium route's Terra. A level on `models.medium` would also move the `quick` lens level, which no cell measured. A thinking-only light route is passed over, as triage's choice needs a model. So the file adds a light route that copies medium's model, fallbacks and `accept`, and sets `thinking: low`. Triage keeps Terra and takes low. `melian doctor` shows heavy and light at low and medium unset.

The medium tier is unchanged, because it was not measured. The verifier is unchanged until a verifier corpus tells levels apart: Sonnet and Opus each passed all nine goldens at low and at high.

## Consequence

A light route also gives the walkthrough a model. The walkthrough is the pull-request summary, and until now the committed routes had no light model, so it reported none. A review of a pull request on the committed routes now spends a Terra request at low on the walkthrough. `--no-walkthrough` skips it, as before. The cost is small beside a review's, and the summary adds to the review, but the change is real and the maintainer should know it.

No lens level names the light tier, so lenses are unaffected. The verifier is routed, so it never falls back through light.

The run is two passes of Sol over corpora of 5 to 24 goldens, one pass of Opus and three of triage over six changes. It supports low as a cost reduction at equal quality, not as a quality gain. Measure again after any lens prompt change, as the tier decision requires of a default.
