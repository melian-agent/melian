# Probing holds to fixed limits

Amends: [A trust-boundary level that probes](2026-11-07-trust-boundary-level-that-probes.md), the probe count

Status: ruled by the maintainer, 2026-11-09, in the builder's session for [pull request #296](https://github.com/melian-agent/melian/pull/296).

Problem: a level that probes was bounded by its own token and tool budgets and each probe's time limit, and a level need set neither budget. Codex's ninth review of #296 found that such a level let a prober run probes without end, each up to ten minutes over a tree of up to 1 GiB. It also found that `boundedHead` read git's whole listing of the head into memory before checking its entry and byte limits. Each recent review had found another unbounded resource of probing, so the maintainer ruled on the class, not the instance.

Choice: Melian holds probing to fixed limits that no level's configuration can lift. `run_probe` refuses a new probe once its prober conversation has run 48, two for each attack a plan may hold, and tells the prober to skip the attacks left. `boundedHead` reads git's listing no further than 64 MiB and refuses the head past it. A level's budgets still bound it below those limits.

What it gives up: a plan of 24 attacks whose every attack needs more than two probes cannot probe them all, and a head whose listing passes 64 MiB, more than 100,000 entries with paths averaging about 600 bytes, is refused a probe though its files are within the limits.
