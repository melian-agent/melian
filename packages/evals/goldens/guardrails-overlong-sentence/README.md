# guardrails-overlong-sentence

Seeded from the findings of [pull request #48's comparison record](../../comparisons/2026-10-05-pr-48.md), where Melian's `conventions` lens held a document to the rule that a sentence past about 25 words should be split. The `overlong-sentence` rule of the `forbidden-patterns` guardrail catches the next one without a model. `melian.golden.yaml` copies the rule from Melian's root `melian.yaml`, and a test fails if the two drift. `live: false`: no model takes part, so a live run would measure nothing.
