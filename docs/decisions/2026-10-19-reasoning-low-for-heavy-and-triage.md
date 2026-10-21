# Low reasoning for the heavy tier and for triage

Status: accepted for milestone 2, step 33.

Amends: [2026-10-19-tier-thinking-routes.md](2026-10-19-tier-thinking-routes.md), which left every committed level unset until measurements chose defaults. The contract, identities and stored versions it records stand.

## Problem

A route can now set a reasoning level, and Melian's committed routes left every level to Pi's default. A default is not a measurement. The triage cell at off observed Terra sending `effort: none`. Sol's behaviour when unset comes from [pull request #153](https://github.com/melian-agent/melian/pull/153)'s telemetry, not from this run: no cell measured Sol unset.

[The reasoning-levels run](../../packages/evals/runs/2026-10-19-reasoning-levels.md) measured the levels, each observed in the request body, over three passes for Sol low, Sol medium and Opus low. Sol covered all eight heavy-tier lens corpora. Low and medium both clear the precision bar on every lens (worst 0.80, on tests, and 0.82 or above elsewhere) and score alike overall: mean precision 0.94 and recall 0.96 at low, 0.92 and 0.98 at medium. Low costs 6% less per golden and finishes 10% sooner over all 68 goldens, 13% over the five original corpora. Sol high, on two passes, scored tests precision 0.73 and no gain elsewhere. For triage on Terra, low raises exact agreement from 0.75 to 0.83 with no under-escalation, and medium adds nothing. The whole gain is one golden: `add-test-only`, which off over-escalated to `careful` in all three passes and low chose `quick`, as expected. Six changes are too few to call it more than that.

## Choice

`melian.yaml` commits `thinking: low` on two routes:

- `models.heavy`, which runs the `careful` and `deep` lens levels. The run is the evidence for Sol. The fallbacks Opus and GPT-5.5 take the same level, as the tier decision says; see the limits below.
- `models.light`, which triage reads. Today no committed route names a light tier, and triage takes the first of light, medium and heavy that routes a model, so it resolves to the medium route's Terra. A level on `models.medium` would also move the `quick` lens level, which no cell measured. A thinking-only light route is passed over, as triage's choice needs a model. So the file adds a light route that copies medium's model, fallbacks and `accept`, and sets `thinking: low`. Triage keeps Terra and takes low. `melian doctor` shows heavy and light at low and medium unset.

The medium tier is unchanged, because it was not measured. The verifier is unchanged until a verifier corpus tells levels apart: Sonnet and Opus each passed all nine goldens at low and at high.

## Consequence

A light route also gives the walkthrough a model. The walkthrough is the pull-request summary, and until now the committed routes had no light model, so it reported none. A review of a pull request on the committed routes now spends a Terra request at low on the walkthrough. `--no-walkthrough` skips it, as before. The cost is small beside a review's, and the summary adds to the review, but the change is real and the maintainer should know it.

No lens level names the light tier, so lenses are unaffected. The verifier is routed, so it never falls back through light.

## Limits

- Low is chosen for cost at equal quality, not for a quality gain. The run does not show low better than medium.
- Contracts recall is 0.50 at both levels, below the 0.6 bar, in all three passes. It does not depend on the level. The corpus is one golden with two expected findings.
- Opus low, the heavy tier's first fallback, is below the precision bar on design: worst 0.75, mean 0.81. The level applies per tier, fallbacks included, so a review that fails over from Sol runs Opus at low. Opus at high was no better on one pass.
- `openai/gpt-5.5`, the second fallback, is unmeasured: there is no credential.
- Sol high and Opus high have fewer passes than the cells above.
- Triage's gain is one golden of six, as above.
- Corpora are small, and one finding moves a cell by 1 over the reported or expected count. Design (18 expected, about 20 reported) moves by 0.05; correctness (7) by 0.14; tests (8 expected) by 0.11 to 0.13; trust-boundary (7) by 0.14; durability (10) by 0.10. Contracts has two expected findings, so one finding moves its recall by 0.50. Measure again after any lens prompt change, as the tier decision requires of a default.

## Walkthrough

The maintainer decided to keep the walkthrough that the light route turns on, unmeasured as it is. Adding a model-dependent public summary was a reviewer's concern, and the maintainer accepted it.
