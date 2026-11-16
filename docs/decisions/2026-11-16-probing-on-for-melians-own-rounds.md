# Probing is on for Melian's own rounds

Amends: [A trust-boundary level that runs probes](2026-11-07-trust-boundary-level-that-probes.md), "no route is committed before the measurement" and "Until then the goldens and the live measurement declare the level that probes in their own lenses", for Melian's own repository lens
Amends: [A trust-boundary level that runs probes](2026-11-07-trust-boundary-level-that-probes.md), "[issue #357](https://github.com/melian-agent/melian/issues/357) bounds it before a level that probes ships", which Melian's own rounds now meet before that issue lands

Status: the maintainer ruled on 2026-11-16, in the coordinator's session: "I've changed my mind, I'd like to turn on probes for our own lens run asap." Earlier that day he had agreed to wait for a live measurement first; this ruling replaces that.

## Problem

A lens reads and searches; it never tries the boundary. Melian can now probe: a planner writes an attack plan, and a prober runs small programs against the head in a sandbox to show each attack. [The probing decision](2026-11-07-trust-boundary-level-that-probes.md) built that, and the maintainer ruled then that no route is committed until the live measurement in [issue #356](https://github.com/melian-agent/melian/issues/356) picks one. So no review of Melian's own pull requests probed, and its trust surfaces still needed a review of record that runs probes by hand.

## Choice

Melian's own `trust-boundary` lens, `.melian/lenses/trust-boundary/LENS.md`, gives its `deep` level `probe: { prober: medium }` and keeps that level's budget. The planner runs on the deep level's own tier, `heavy`, which the built-in lens sets and this file leaves alone. The prober runs on `medium`. The root `melian.yaml` routes `heavy` to `openai-codex/gpt-6.1-sol` and `medium` to `openai-codex/gpt-5.6-terra`, both at `thinking: low`, so the prober is the cheaper model. No tier and no route changed. The built-in lens is unchanged, so no shipped level probes.

No measurement picked this pair. It is the committed tiers, taken as the default so that real rounds show what probing finds and costs. The live measurement in [issue #356](https://github.com/melian-agent/melian/issues/356) still runs, and its result may change the pair.

## When a probe runs

The level probes only when every condition below holds. Otherwise it runs as an ordinary deep level, one conversation that reads, and the lens's record says why.

- Triage, or a floor, puts `trust-boundary` at `deep`. Its band is `quick` to `deep` by default (`LevelBand.of` in `packages/core/src/triage.ts`), and Melian's `melian.yaml` sets no floor for it. A review with no decision model runs the lens at its default level, `careful`, which does not probe.
- The host has said whose head it is, and trusts it. That is a pull request's head that a writer pushed to the base repository, or a range the reviewer vouches for with `--trust-head`. `writerTrust` and the `committedRange` default in `packages/cli/src/commands.ts` decide it. A range review such as `melian review main...HEAD` without `--trust-head` does not probe.
- The base policy trusts writers, `trust: { writers: true }`, which Melian's `melian.yaml` sets.
- The sandbox runs on this machine: `Probe.availability` says sandbox-runtime supports the platform and finds its tools.
- The head's own tree opens for a probe, within its limits and with no link out of it.

The first four are `probeRefusal` in `packages/pipeline/src/review.ts`, and the fifth is its call to `headRefusal`. That file's `withoutProbes` adds two more: the prober's tier must route, and the plan must not refuse it. `runAt` sets a run's `probe` only when `withoutProbes` finds no reason, and records the reason otherwise.

Two facts follow from where the lens file is read. A pull request's round reads lens files from its base, so this change probes only in rounds on pull requests whose base holds it, never in this pull request's own rounds. And the `melian round` workflow, `.github/workflows/melian-round.yml`, installs none of the tools sandbox-runtime needs on Linux: bubblewrap, socat and ripgrep. The `check` workflow installs them for the probe tests and lifts Ubuntu's user-namespace restriction. Unless the round's runner image already carries them, an Actions round's deep level runs without probes and says the sandbox cannot run. The round job's `melian doctor` line `probes` shows which.

## What it costs

These costs were known and accepted; they now apply to Melian's own rounds.

- No early verification. [The probing decision](2026-11-07-trust-boundary-level-that-probes.md) says: "A lens task that holds a level that probes starts no verification wave, so its other lenses' claims wait for the final step as its probing claims do, which run their probes again first." In `verifyAsLensesEnd`, in `packages/pipeline/src/review.ts`, that applies only when a run actually probes.
- A repeat review probes again. [The probing-runs decision](2026-11-14-probing-runs-not-reused.md) says: "a repeat review of a head whose lenses include a probing level runs every lens again, and pays for it." [The per-request reuse decision](2026-11-15-lens-runs-reused-per-request.md) narrowed it: "a repeat review of a selection with a finished probing run runs the probing lens again, and pays for it alone." The other lenses are copied.
- Twice the deep level's budget. Each of the planner and the prober takes the level's token and tool budgets whole, 600,000 tokens and 90 tools here, as [the probing decision](2026-11-07-trust-boundary-level-that-probes.md) says.
- The prober's model is missing from the check's lineage. A prober on a tier of its own is the case [the lineage limit](2026-11-14-prober-tier-lineage-limit.md) records, and [issue #438](https://github.com/melian-agent/melian/issues/438) holds the fix. The verdict is unaffected.
- The verifier's prompt is unbounded. The maintainer accepted on 2026-11-09 that several probing claims merged into one defect can pass the verifier's context window and leave the review not reviewed. [Issue #357](https://github.com/melian-agent/melian/issues/357), which bounds it, is still open.

## What it does not change

The routes, the tiers, the built-in lens, triage's question and every probing limit stay as they were. A fork's head and an untrusted range still never probe. Only one level probes, so [issue #349](https://github.com/melian-agent/melian/issues/349), which serialises probes across lenses before a second level probes, is not yet needed.
