# A fallback may name its own thinking level

Status: accepted on 2026-11-16 by the maintainer, in the coordinator's session, for [issue #489](https://github.com/melian-agent/melian/issues/489). The coordinator settled the details below in its messages to the builder on 2026-11-16; they are the coordinator's answers, not rulings.

Amends: [2026-10-19-tier-thinking-routes.md](2026-10-19-tier-thinking-routes.md), the level a failover model runs at
Amends: [2026-10-19-reasoning-low-for-heavy-and-triage.md](2026-10-19-reasoning-low-for-heavy-and-triage.md), the level heavy's fallbacks take
Amends: [2026-11-08-lens-routes.md](2026-11-08-lens-routes.md), the shape of a lens route's fallbacks
Amends: [2026-10-24-design-lens-on-codex-route.md](2026-10-24-design-lens-on-codex-route.md), the design lens's fallback level

## Problem

A route names one `thinking` level, and every model on it ran at that level, the fallbacks included. The word means different things to different providers. On the Codex models `low` shortens reasoning and the model still calls its tools. On an Anthropic model `low` is an effort setting that cuts all output, tool calls included.

Example: on 2026-11-15 Codex reached its usage limit, and a round on [pull request #471](https://github.com/melian-agent/melian/pull/471) moved every lens to `anthropic/claude-opus-5-5`. The six lenses at `low` made no tool call. Across 218 stored rounds, 13 of the 14 failed-over lens runs at `low` made none, where a Codex lens at `low` makes none in about 1% of runs. The fallback can do the work: on 2026-11-09 a failed-over design lens on Opus at `high` made 18 tool calls.

## The rule

1. **Shape.** A fallback entry is a model, as before, or `{ model, thinking }`. An entry with a level runs at it. An entry without one runs at the route's level, as every fallback did. The route's first model always runs at the route's level.
2. **Every place a route is written.** The entry reads the same in a tier's route, a lens's own route, the verifier's route, the root `melian.yaml` and a preference file. `--model` replaces the route with one model, which runs at the route's level, so no fallback level survives it. A derived route's stand-in model runs at the route's level, since no entry names it. A verifier that borrows a lens route runs every model of it at the verifier's level, never a lens fallback's own.
3. **Policy.** Under `acceptOverridden: false`, a fallback whose level differs from the level committed policy gives that model is dropped from the route, as a fallback outside `accept` is. A route whose every model is dropped that way is refused, and the reason names the model and both levels.
4. **`melian doctor`.** A route line prints each fallback with its own level, `anthropic/claude-sonnet-5-5 at medium`. It warns when a fallback names no level and inherits `off`, `minimal` or `low` from a route whose first model is another provider's, since that is the case above.
5. **Lineage.** A check records the level its answering model ran at beside the model, so a stored review says what answered and how. The field is optional, so a record written before it reads as it did.
6. **Identity.** A model's own level is part of what a lens, a verifier, triage and the walkthrough are asked, so it enters each request's key. A route whose fallbacks change level is a changed request, and the lens runs again.
7. **Melian's own policy.** The light and medium Claude fallback is `{ model: anthropic/claude-sonnet-5-5, thinking: medium }`. Heavy's Opus fallback runs at `medium`, and its `openai/gpt-5.5` fallback names `low`, the level it already ran at, because it is another provider's model from `openai-codex/gpt-6.1-sol` and the rule 4 warning would otherwise fire. The design lens's Opus fallback stays at `high`, the level its route names, now written on the entry: the 18 tool calls of 2026-11-09 came at `high`, and the design lens is the one lens that worked after failover. The verifier is unchanged. Every first choice and every tier keeps its model and level.

## Why

One level per model is the smallest change that fixes the case. A level per provider would need a table of providers that a route never names. Raising the route's level would raise the Codex models, whose `low` was measured and chosen, as the low-reasoning decision records.

One level above the route's suits Claude because Claude's `medium` still calls tools, and costs less than `high`. The design lens stays at `high` because it was already there and worked.

## Consequences

- Stored lens, verification, triage and walkthrough requests do not match the new routes, so the first review of each head after the change asks every lens on a changed route again once. A new head runs every lens anyway.
- A failover run on Claude costs more per run, since a run that calls its tools reads more and writes more. Sonnet 5.5 is $2 a million input tokens and $10 a million output; Opus 5.5 is $4 and $20. A run at `low` that read nothing cost little because it reviewed nothing. The live check in [issue #489](https://github.com/melian-agent/melian/issues/489) measures the difference on one golden.
- The lens task, the verification task and the verdict document take their next versions, since their stored routes may now hold a level per model and lineage the level that answered. Each version gets a reopen test from a fixture its previous version's code recorded.

## Limits

- Lineage exists only for a check that left the committed route, so the answering level is recorded only there. A committed fallback inside `accept` leaves no lineage, and its level is not on the check record. That level is still in the review's telemetry, which names the model and level each conversation ran at. Recording it on every record would change every existing verdict's fingerprint and the list of checks that left the routes.
