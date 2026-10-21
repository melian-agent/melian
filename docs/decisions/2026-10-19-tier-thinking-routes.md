# A reasoning level per model tier

Status: accepted and built for milestone 2, step 33.

This adds an optional reasoning level beside the model routes described in [the historical route-resolution decision](2026-10-05-review-plan-resolution.md). The current root-policy and local-override rules remain.

Amends: [2026-10-18-reasoning-telemetry.md](2026-10-18-reasoning-telemetry.md), allowing configuration to choose the requested level while retaining the capture, counter, timing, privacy and settlement rules.

## Problem

Melian has no way to choose reasoning effort. A comparison of models therefore also compares their defaults, without controlling them.
For example, Pi's unset agent level maps to no reasoning for Terra and a provider default for Sol, while Claude's adaptive mode uses high effort.
The capture added in [pull request #153](https://github.com/melian-agent/melian/pull/153) exposes those differences but cannot select another level.

## Choice

`models.<tier>.thinking` is optional beside `model`. Its values come from the installed pi-ai `ModelThinkingLevel` type, which Pi Durable uses.
The runtime schema checks its value table exhaustively against that type. It declares no parallel union.
Core imports this type alone; it imports no Pi runtime. This adds no runtime dependency or published type reference.

Only root policy sets a committed level until routes resolve per path. Nested policy refuses the key.
Working-tree preferences override it, with the same precedence and source restrictions as model routes.
A thinking-only preference does not count as a model override and does not suppress route derivation.
The plan records the level and its setting file independently of model lineage. `--model` changes models and keeps tier levels.
`melian doctor` prints every tier's level and setting file, or `unset; Pi default`.

Unset preserves existing requests. Conversations retain Pi's default; direct triage keeps its existing raw completion call and unspecified capture.
An explicit level configures each conversation through Pi's `configure(..., { thinkingLevel })` API.
Pi supplies that level to generation, tool continuations and compaction. Model-only failover preserves it.
The level belongs to the serving tier, including accepted, derived and failover models. Pi and its adapters remain the authority for supported levels and provider mappings.

Each lens uses its scrutiny level's tier. Escalation uses the next scrutiny level's tier.
The verifier always uses verifier thinking, even when its models come from lens routes. A thinking-only verifier route still permits that fallback.
The walkthrough uses light thinking. Its existing revision cache and explicit rerun rules remain unchanged.
Triage uses the lens tier supplying its selected model: light, medium, then heavy.
An explicit triage level uses pi-ai's simple completion API, with off represented by an omitted reasoning option, as Pi does.
The reserved decision tier remains available for future decision-model adapters; this work adds none.

Lens selection identity includes both the initial and escalation levels. Verifier candidate identity includes verifier thinking.
The direct triage model's name includes an explicit level, which joins the fallback decider's identity and prevents cross-level attachment.
Unset identities retain their former spelling. Telemetry records the tier level as requested and still observes the actual sent body separately.

## Stored versions

Lens tasks advance from 3 to 4, verifier tasks from 1 to 2, and walkthrough tasks from 1 to 2.
Their optional level fields migrate without inventing a level. Existing child agent settings remain unchanged on replay.
The plan's optional level and setting-file fields advance the verdict document from 10 to 11 and adjudication tasks from 3 to 4.
Adjudication migration preserves existing timing checkpoints; only versions before 3 gain the legacy timing marker.
Review-index strings and decision keys retain their shapes and versions. Usage receipts and publication shapes do not change.
The open publication work in [pull request #152](https://github.com/melian-agent/melian/pull/152) and [pull request #155](https://github.com/melian-agent/melian/pull/155) changes other stored versions.
Fixtures recorded through main at `5175c664` prove reopening without fabricated reasoning settings.

## Measurement

Live evals accept `MELIAN_EVAL_THINKING="heavy=medium,verifier=high"` for one run.
The runner parses it before credential discovery, refusing unknown or repeated tiers and unknown levels.
Overrides apply after model routing and preserve route models and fallbacks. Unlisted tiers keep their configured level.
Lens and verifier goldens use those routes; direct triage goldens take the light override, their existing model role.
Spend lines use the recorded telemetry, which already prints requested, sent and provider-reported levels.
No committed tier gains a level in this change. Choosing defaults waits for measurements.
