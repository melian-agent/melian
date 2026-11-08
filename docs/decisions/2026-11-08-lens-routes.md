# A lens names its own model route

Status: proposed for plan step 37 ([issue #243](https://github.com/melian-agent/melian/issues/243)). It awaits an attacking review and the maintainer's ruling, and changes nothing until it is accepted.

Amends: [2026-10-24-design-lens-on-codex-route.md](2026-10-24-design-lens-on-codex-route.md), whose option C this is.

## Problem

A lens level names a tier, and a tier's route serves every lens on it. One lens cannot get a model of its own without taking a tier from the others. Example: to run the design lens on Codex's model and effort, Melian's own repository routed `medium` to `gpt-5.6-sol` at `high` and moved seven lenses' `quick` levels to `light`, through extension files under `.melian/lenses/` that exist only to move tiers. A team that wants a second lens on its own model has no tier left to free.

## The rule

1. **Shape.** `lenses.<name>.route` takes the same keys as `models.<tier>`: `model`, `thinking`, `fallbacks`, `accept`, `unavailable` and `acceptOverridden`. The same layering limits apply. A preference file and a nested `melian.yaml` may set `model`, `thinking` and `fallbacks`, never the last three; only the root `melian.yaml` sets policy. The checks on `models.<tier>` apply unchanged: fallbacks need a model, an `accept` is not empty, and `acceptOverridden: false` needs a model or an `accept`.
2. **Precedence.** A lens with an effective route runs every level on it, in place of the level's tier. The route sets the model and the thinking for every level, so escalation from `quick` stays on the route. A `lenses.<name>.tier` on a routed lens is ignored, and `melian doctor` says so, naming the file. The tier a level declares still stands for a review whose configuration routes no such lens.
3. **Policy.** The committed route, from the root `melian.yaml` alone, judges the lens: its `accept`, `unavailable` and `acceptOverridden`, as a tier's do. A preference file that changes a committed route's model or fallbacks is recorded as `by` that file, as for a tier. A preference file that gives a route to a lens whose committed files route none moves the lens, as a preference `tier` does today. Each level is then judged under its committed tier's policy, and refused when that tier sets `acceptOverridden: false` and the route's model is outside its `accept`.
4. **`--model`.** It replaces every lens route, as it replaces every lens tier, and the lineage records `by: --model`. A lens route with `acceptOverridden: false` refuses it unless its `accept` lists that model.
5. **The plan.** `StoredPlan` gains `lensRoutes`, one resolved route per routed lens, keyed by the lens's name and scope. Each is resolved by the code that resolves a tier, with the same statuses. `PlannedLevel` gains `route: true` on a routed lens's levels. `routes()`, `providers()`, `judge()` and `mark()` read a lens's route before its tier. Triage, the walkthrough and the verifier keep their tiers; a lens route is never a verifier's route, but its models count as finders for the family check.
6. **Stored shape.** The plan is stored in a verdict's provenance. `VerdictDocument` takes the next version, so an older Melian refuses a verdict whose plan it would misread, and a reopen test reads a verdict the current version wrote. A plan stored before the step has no `lensRoutes` and reads as it did. `LensTask`'s input already carries each run's resolved models and thinking, so its shape does not change.
7. **Lineage.** `CheckLineage.moved` names a lens route as `lens route`, as in `moved: { by, from: "heavy", to: "lens route" }`. A run on its committed lens route records no lineage. A run on a fallback outside that route's `accept` does, as for a tier.
8. **Identity.** A route is not part of a lens's `version`, as a tier's route is not today. The review index already keys each run by the models it resolved and its thinking, so a changed route runs the lens again. Findings keep their IDs and dismissals.
9. **`melian doctor`.** It prints a `route` line for each routed lens beside the tier lines, and a level as `careful on lens route (openai-codex/gpt-5.6-sol)`. The inversion check compares only budgets between levels that share a route.
10. **Melian's own policy.** The root `melian.yaml` gives `design` its route: `openai-codex/gpt-5.6-sol` at `thinking: high`, falling back to `anthropic/claude-opus-5-5`, accepting both. `models.medium` returns to Terra at `low` with the light route's fallbacks and `accept`, so every `quick` level keeps the model and effort it runs today. The `quick: { tier: light }` lines leave `contracts`, `conventions`, `correctness`, `removed-behaviour`, `tests` and `trust-boundary`. `durability`'s `quick` returns to `medium`. `design` drops `tier: medium` and keeps its tools, budget and body. The extension files stay where they still hold budgets.

## Why

A route on the lens is the smallest unit that answers the problem: it moves one lens and nothing else. A sixth tier would solve one lens and touch every tier order, as the earlier decision says. A route per level would let one lens split across models, which no one has asked for, and would put a model choice into every level's identity.

Reusing the tier's resolution code keeps one rule for derive, fail and refusal. Ignoring a tier on a routed lens, rather than refusing the configuration, lets a preference file that retiers every lens keep working beside a committed route.

## Consequences

- Behaviour stays the same for Melian's own rounds: `design` keeps Sol 5.6 at high, and each `quick` level keeps Terra at low.
- A verdict written by this Melian cannot be read by an older one. This is the usual cost of a version bump.
- A preference route on an unrouted lens is judged by its committed tier, so `acceptOverridden: false` on that tier still holds.
