# Low reasoning for the heavy tier and triage

Stacked on [pull request #157](https://github.com/melian-agent/melian/pull/157).

`melian.yaml` sets `thinking: low` on `models.heavy` and adds a `models.light` route that copies medium's model, fallbacks and `accept` with `thinking: low`. Triage resolves to the first routed tier of light, medium and heavy, so it now runs Terra at low. Medium and verifier levels stay unset.

The [run record](../../packages/evals/runs/2026-10-19-reasoning-levels.md) holds the evidence and the [decision](../decisions/2026-10-19-reasoning-low-for-heavy-and-triage.md) the reasoning. A light route also lets the walkthrough run on the committed routes; the decision says so.

A test in `packages/cli/test/models.test.ts` loads the committed routes and reviews on the fake model. It checks that the lens and triage requests carry effort low and the verifier's stays off, and that the light route keeps medium's model. Raising heavy to high, dropping heavy's level, and changing light's model each fail it.
