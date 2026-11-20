# Parity first, then cost

Status: the maintainer ruled on 2026-11-18, in the coordinator's session: "we want to get to parity at the same cost, later we can optimise cost, first, lets just find parity. I think we prematurely optimised on the wrong thing." Earlier that day, in the same session, he said: "Parity in capability is the only way that will create pairty in results." He confirmed the reading of "the same cost" below on 2026-11-18. The wording that follows is the builder's.

## Problem

Melian's first goal is to find what the review of record finds. Its lenses were sized for cost before anyone had shown they reach that. They differ from a review of record in what they can do:

- A review of record is one agent at full effort with a shell. It runs for 18 to 75 minutes.
- A lens has `read_file`, `search` and `list_files`. In this repository it gets 90 tool calls and 600,000 tokens, and `low` thinking on its first model.
- Only the design lens has the graph tools, with 5 million tokens and 400 calls. Only the trust lens probes.

A lens that cannot read a file cannot find a defect in it. For 8 of 21 pinned past misses, the file sat past the 200 KiB cut of the owning lens's prompt, and the lens did not read it. Cost savings in the budgets, levels and routes bought that gap.

## Choice

- "The same cost" means a Melian round may cost about what a review of record and Codex's review cost together on the same pull request. Cost is optimised after parity is shown, not before.
- When a choice trades a lens's capability for cost, the choice is capability until parity is shown. The pull request states the cost it adds.
- [Issue #561](https://github.com/melian-agent/melian/issues/561) measures a parity arm against the committed arm, on the pinned past misses and the goldens. The parity arm gives every lens the graph tools, the design lens's budget, `high` thinking and its deep level, with probing where the lens may probe.
- Melian's own committed policy takes those settings only after that run record is in, in a pull request the maintainer reads.

Related work: [issue #559](https://github.com/melian-agent/melian/issues/559) and [issue #555](https://github.com/melian-agent/melian/issues/555).

## What does not change yet

This decision sets the order of work. It changes no committed budget, level or route, and it amends none of the decisions that set them:

- [Lens budgets](2026-10-04-lens-budgets.md), of 2026-10-04.
- [Scrutiny levels](2026-10-04-scrutiny-levels.md), of 2026-10-04.
- [Low reasoning for the heavy tier and for triage](2026-10-19-reasoning-low-for-heavy-and-triage.md), of 2026-10-19.

A later decision changes each of them when the measurement supports it.

## Why

Parity in results needs parity in capability. A lens that cannot open the file, run the probe or follow the caller cannot match a reviewer that can, however its cost compares. Cost tuning earlier fixed the wrong variable. Measuring first shows which capability closes the gap, and what it costs, so the later cost work starts from a review that already finds the defects.
