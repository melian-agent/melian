# guardrails-bare-issue-reference

Seeded from the findings of [pull request #50's comparison record](../../comparisons/2026-10-05-pr-50.md), where Melian's `conventions` lens flagged bare issue and pull request numbers in documents. The `bare-issue-reference` rule of the `forbidden-patterns` guardrail catches the next one without a model. `melian.golden.yaml` copies the rule from Melian's root `melian.yaml`, and a test fails if the two drift. `live: false`: no model takes part, so a live run would measure nothing.
