# The design lens runs on Codex's model and effort

Status: accepted on 2026-10-24 by the maintainer, who chose option B now and option C as its own plan step.

Amends: [2026-10-19-reasoning-low-for-heavy-and-triage.md](2026-10-19-reasoning-low-for-heavy-and-triage.md), which left `medium` unset and named no light lens level.

This decision is the authority for the `medium` route in Melian's own `melian.yaml`. [The committed-routes decision](2026-10-07-committed-routes.md) set it to Terra. [The subscription verifier decision](2026-10-08-verifier-on-codex-subscription.md) superseded part of that decision, and the decision index retired it whole. No active decision held the route. Step 26's audit of partial `Supersedes:` lines covers that gap in general.

## Problem

The maintainer asked for a design lens with the model, effort and room to explore of Codex's adversarial review. Then the two can be compared, and the lens can replace the review. Codex runs `gpt-5.6-sol` at reasoning effort `high`, as one agent with no budget. The design lens ran on `heavy`: `openai-codex/gpt-6.1-sol` at `low`, with 300,000 tokens and 45 tool calls.

A lens level names a tier, never a model, and a lens can use three tiers. None was free. `light` is triage's and the walkthrough's route. `medium` ran the `quick` level of seven lenses, and triage chose `quick` in 100 of 268 stored rounds. `heavy` ran every other level. Example: route `medium` to Sol at high, and a round triages `correctness` to `quick`. That lens then runs at high effort, on a model at twice Sol 6.1's input price.

## Choice

For now, option B: free `medium` for the design lens in Melian's own repository, with no code change.

- Every other lens's `quick` level moves to `light` through committed extensions under `.melian/lenses/`. That is new files for `contracts`, `conventions`, `tests` and `trust-boundary`, and an edit in place to `correctness`, `removed-behaviour` and `durability`. `light` and the old `medium` route both run `openai-codex/gpt-5.6-terra`, so `quick` keeps its model.
- `models.medium` routes `openai-codex/gpt-5.6-sol` at `thinking: high`, falling back to `anthropic/claude-opus-5-5`, and accepts those two.
- `.melian/lenses/design/LENS.md` extends `design` with `tier: medium` and a budget of 8 findings, 3,000,000 tokens and 150 tool calls. Those are the numbers Melian's rounds already raised the lens to. Codex has no budget, and a lens needs one.
- A test in `packages/core/test/lens.test.ts` holds the shape: under Melian's own files, `design.careful` is the only level on `medium`, and all seven `quick` levels run on `light`.

Then option C, plan step 35: a lens names its own model route. That step is done when these extension files are gone. The design extension keeps its budget.

## Why

B needs no new mechanism. It changes only Melian's own policy, and the maintainer can reverse it by deleting files. C is the right shape, but it changes `ReviewPlan` and its stored shape, check lineage, the `acceptOverridden` guard, `melian doctor` and lens identity. That is a step of its own with an attacking review, not something to fold into a routing change.

A sixth lens tier would also free a route, but it touches every tier order and solves one lens, so C is preferred.

## Consequences

- `quick` changes effort. The old `medium` route set no level; `light` sets `low`. No cell measured `quick` at either level, so this is unmeasured, as the earlier decision's `quick` was.
- The design lens costs more per round. Sol 5.6 lists at 4 and 20 dollars per million input and output tokens; Sol 6.1 lists at 2 and 10. The lens also runs at high effort, with ten times the built-in budget.
- Each of the 64 golden trees that carries a repository lens carries all of them, as the corpus test requires. So a golden runs the lenses Melian runs. Step 35 removes the routing-only copies with the originals.
- The design lens's goldens and live measurements so far ran on `heavy`. A live rerun of the design corpus on the new route is owed before its numbers are quoted for this route.
- `melian doctor` warns about no inverted levels: `quick` on `light` sits below `careful` and `deep` on `heavy`.
- A round script that writes its own lens extensions, or routes `medium` in `melian.local.yaml`, undoes this. Rounds must leave the committed design extension and the `medium` route alone.
