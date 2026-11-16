# Probing is on for Melian's own rounds, in a lens of its own

Amends: [A trust-boundary level that runs probes](2026-11-07-trust-boundary-level-that-probes.md), "no route is committed before the measurement" and "Until then the goldens and the live measurement declare the level that probes in their own lenses", for Melian's own repository lens `trust-boundary-probes`
Amends: [A trust-boundary level that runs probes](2026-11-07-trust-boundary-level-that-probes.md), "[issue #357](https://github.com/melian-agent/melian/issues/357) bounds it before a level that probes ships", which Melian's own rounds now meet before that issue lands

Status: ruled by the maintainer on 2026-11-16, in the coordinator's session, in the rulings quoted below.

## Problem

A lens reads and searches; it never tries the boundary. Melian can now probe: a planner writes an attack plan, and a prober runs small programs against the head in a sandbox to show each attack. [The probing decision](2026-11-07-trust-boundary-level-that-probes.md) built that, and held it off until the live measurement in [issue #356](https://github.com/melian-agent/melian/issues/356) picks the routes. So no review of Melian's own pull requests probed.

A level that probes cannot also read. Its planner may report nothing but an injection attempt, and its prober may report only a finding a failing probe backs (`refusal` in `packages/pipeline/src/lens-tools.ts`). A defect no probe can reach is lost.

Example: a pull request changes `.github/workflows/melian-round.yml` so a login reaches a step that runs head code. No probe can run GitHub Actions, so the prober skips the attack. If the `trust-boundary` lens's `deep` level probed, the round would pass, where the reading `deep` level could have blocked. The review of record on [pull request #494](https://github.com/melian-agent/melian/pull/494) showed this with a scripted run: both unprobed reports were refused and the review passed.

## Choice

Melian's own rounds run two trust-boundary lenses.

- `trust-boundary`, `.melian/lenses/trust-boundary/LENS.md`, is unchanged. It reads at every level, as before.
- `trust-boundary-probes`, `.melian/lenses/trust-boundary-probes/LENS.md`, extends it. It keeps its rules, instructions and budgets, and adds one line to its body, so the two lenses' conversations differ. Its `deep` level sets `probe: { prober: medium }`. The planner runs on the deep level's own tier, `heavy`, which the built-in lens sets. The prober runs on `medium`.
- The root `melian.yaml` names `lens.trust-boundary-probes` in the `full` tier, and gives it `trust-boundary`'s `paths` with `level: { floor: deep }`. So it runs its level that probes on every review that selects it, whatever triage answers.

`melian.yaml` routes `heavy` to `openai-codex/gpt-6.1-sol` and `medium` to `openai-codex/gpt-5.6-terra`, both at `thinking: low`, so the prober is the cheaper model. No tier and no route changed, and the built-in lens is unchanged, so no shipped level probes. No measurement picked this pair. It is the committed tiers, taken so that real rounds show what probing finds and costs, and [issue #356](https://github.com/melian-agent/melian/issues/356) may change it.

[Issue #497](https://github.com/melian-agent/melian/issues/497) is the proper fix: a level that probes also reports what it finds by reading. Once it lands, `trust-boundary`'s own `deep` level can probe, and the second lens goes.

## The rulings

The maintainer gave all four on 2026-11-16, in the coordinator's session.

1. "I've changed my mind, I'd like to turn on probes for our own lens run asap." This replaced his agreement earlier that day to wait for the live measurement.
2. On turning probing on before [issue #357](https://github.com/melian-agent/melian/issues/357), which bounds probe evidence in the verifier's prompt. The coordinator put two options: probing on now with issue #357 next, or issue #357 first. He recommended the first, because the failure is a safe one: a round that hits it reads not reviewed. The maintainer answered "agree".
3. On a level that probes and so cannot read, after the review of record found it. The coordinator put three options: turn it on as built; reach the probing level only by escalation from a reading level; or change the level so it both reads and probes. The maintainer answered "agree, but basically its not complete until we have at least B". So probing is not complete until one review both reads and probes.
4. On how to get both with no code change. The coordinator put three ways: two lenses; probing at `careful` instead of `deep`; or a code change so a level that probes also reads. He recommended two lenses now, with the code change filed as the proper fix, and the probing lens's level pinned to `deep` so it probes on every review that touches its paths. The maintainer answered "agree". The code change is [issue #497](https://github.com/melian-agent/melian/issues/497). The pin replaces his agreement earlier that day to leave the level to triage for a week.

He also ruled on [issue #493](https://github.com/melian-agent/melian/issues/493), an attack whose every probe showed nothing: it stays unanswered unless the prober skips it and says why. That is not built yet.

## When a probe runs

`trust-boundary-probes` probes only when every condition below holds. Otherwise its `deep` level runs as an ordinary `deep` level, one conversation that reads, and the lens's record says why.

- The host has said whose head it is, and trusts it. That is a pull request's head that a writer pushed to the base repository, or a range the reviewer vouches for with `--trust-head`. `writerTrust` and the `committedRange` default in `packages/cli/src/commands.ts` decide it. A range review such as `melian review main...HEAD` without `--trust-head` does not probe.
- The base policy trusts writers, `trust: { writers: true }`, which Melian's `melian.yaml` sets.
- The sandbox runs on this machine: `Probe.availability` says sandbox-runtime supports the platform and finds its tools.
- The head's own tree opens for a probe, within its limits and with no link out of it.

The first three are `probeRefusal` in `packages/pipeline/src/review.ts`, and the fourth is its call to `headRefusal`. That file's `withoutProbes` adds two more: the prober's tier must route, and the plan must not refuse it.

A pull request's round reads lens files and policy from its base. So this change probes only in rounds on pull requests whose base holds it, never in this pull request's own rounds.

## What it costs

- About one more `deep` run per review. The lens's paths are `trust-boundary`'s whole paths and its floor is `deep`, so every review that runs the `full` tier and changes a file outside the golden corpus runs it. Its planner and prober each take the level's token and tool budgets whole: 600,000 tokens and 90 tools. Where a probe may not run, it is a second reading `deep` run beside `trust-boundary`'s own.
- One defect can show twice. Where both lenses report one defect and their reports do not merge, the review lists it twice.
- Each lens has its own findings budget. `trust-boundary` keeps its own, 8 at `careful`. The probing run has 12 at `deep`, shared by its planner and prober.
- A live eval of a tiered golden runs the new lens, and counts its findings as reported. One it reports alone answers no `lens.trust-boundary` expectation, so a defect both lenses report, in findings the verdict does not merge, lowers precision. A comparison names each finding's check, so it lists the new lens's findings under `lens.trust-boundary-probes`. Its status line shows the fallback magnifying glass beside the lens's name, since the emoji table names checks. The trust floor does cover it, by the maintainer's ruling of 2026-11-16, as [the trust-floor amendment](2026-11-16-trust-floor-covers-the-probing-lens.md) records.
- No early verification. [The probing decision](2026-11-07-trust-boundary-level-that-probes.md) says: "A lens task that holds a level that probes starts no verification wave, so its other lenses' claims wait for the final step as its probing claims do, which run their probes again first." In `verifyAsLensesEnd`, in `packages/pipeline/src/review.ts`, that applies only when a run actually probes.
- A repeat review probes again. [The per-request reuse decision](2026-11-15-lens-runs-reused-per-request.md) says: "a repeat review of a selection with a finished probing run runs the probing lens again, and pays for it alone." The other lenses are copied.
- An attack whose every probe showed nothing still counts as answered until [issue #493](https://github.com/melian-agent/melian/issues/493) is built as the maintainer ruled. A probe that timed out answers its attack, and the lens's record reads as though the attack was probed.
- The verifier's prompt is unbounded until [issue #357](https://github.com/melian-agent/melian/issues/357) lands. A merged defect of several probing claims at their limits can pass the verifier model's context window and leave the review not reviewed.
- Actions rounds do not probe. The `melian round` workflow, `.github/workflows/melian-round.yml`, installs none of bubblewrap, socat and ripgrep, which sandbox-runtime needs on Linux; the `check` workflow installs them for the probe tests. The review of record found this pull request's own Actions round log saying bubblewrap is not installed. So an Actions round runs the probing lens as a second reading `deep` run, and the round job's `melian doctor` line `probes` says so.
- The prober's model is missing from the check's lineage. A prober on a tier of its own is the case [the lineage limit](2026-11-14-prober-tier-lineage-limit.md) records, and [issue #438](https://github.com/melian-agent/melian/issues/438) holds the fix. The verdict is unaffected.

## What it does not change

The routes, the tiers, the built-in lens, triage's question and every probing limit stay as they were. A fork's head and an untrusted range still never probe. Only one level probes in any review, so [issue #349](https://github.com/melian-agent/melian/issues/349), which serialises probes across lenses before a second level probes, is not yet needed. In Melian's own rounds and its tiered goldens it is `trust-boundary-probes`'s `deep`. The six `trust-boundary-probe-*` goldens leave that lens out of their `full` tier and their scripts, so their own `trust-boundary` `deep` is the one. The probing measurement in [issue #356](https://github.com/melian-agent/melian/issues/356) reroutes or strips that lens's probe alone, so a second lens extending it would probe in every arm, its arm without probes too. So a probing golden runs the lenses it ran before this change, and the measurement measures what it measured on `main`.
