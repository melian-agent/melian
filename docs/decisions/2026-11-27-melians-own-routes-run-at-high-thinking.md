# Melian's own review routes run at high thinking

Status: agreed by the maintainer on 2026-11-27, in the coordinator's session ("Agree to high reasoning"), for [issue #650](https://github.com/melian-agent/melian/issues/650).

Amends: [2026-10-19-reasoning-low-for-heavy-and-triage.md](2026-10-19-reasoning-low-for-heavy-and-triage.md), the thinking level of `light` and `heavy`
Amends: [2026-10-24-design-lens-on-codex-route.md](2026-10-24-design-lens-on-codex-route.md), the thinking level of `light`
Amends: [2026-11-08-lens-routes.md](2026-11-08-lens-routes.md), the thinking level of `medium` in rule 10

Choice: `models.light.thinking`, `models.medium.thinking` and `models.heavy.thinking` in the root `melian.yaml` are `high`. Nothing else in the routes changes: the models, fallbacks and `accept` lists stay, the design lens keeps its own route at `high`, and the verifier's level stays unset. Every clause of the amended decisions other than the level stands, the walkthrough's light route and `--no-walkthrough` included.

## Problem

At `low`, Melian's own lenses finish fast and find little. Example: re-reviews of three merged pull requests, [#613](https://github.com/melian-agent/melian/pull/613), [#619](https://github.com/melian-agent/melian/pull/619) and [#623](https://github.com/melian-agent/melian/pull/623), were scored against the 23 real defects they held. At `low`, most lenses finished in under 30 seconds, and four runs found none of #619's 7 defects.

## Measurement

The maintainer's parity loop ran each setting on the committed Codex routes:

| Setting, on the committed Codex routes | Recall | Cost per change |
|---|---|---|
| As committed, `low` (2 passes per change) | 24% | $4.04 |
| Only thinking raised to `high` (2 passes per change) | 39% | $6.31 |
| All runs at `high`, three settings (6 passes per change) | 40% | $6.31 to $7.11 |

Raising thinking alone took most of the gain. Noise did not rise: each run at `high` raised three or four style findings, and the verifier refuted one or two.

## Why all three tiers

The measured setting raised `light`, `medium` and `heavy` together. Triage takes its level from `light`, the first tier that routes a model, so `light` moves with the lenses rather than staying at a level nobody measured beside them. `light` and `medium` keep routing the same model at the same effort, so every `quick` level still runs alike.

## Consequences

- A round costs about 60% more, and a prober takes 4 to 11 minutes.
- No key changes. A lens request already holds its thinking level, as the Lens request row of [the identity guideline](../guidelines/identity.md#pipeline) says, so a stored run at `low` is never reused for a request at `high`. The first round after this lands asks every lens again once.
- A pull request's round reads routes from its base, so the pull request that makes this change is reviewed at `low`. Rounds run at `high` from the next pull request.
