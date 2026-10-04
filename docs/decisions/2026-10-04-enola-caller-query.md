# Enola caller query

Choice: Callers of changed code come from `enola plan --json`, the command-line twin of the `plan_check` MCP tool on the same code path, which reports each target's governing constraints and blast radius and, for a patch, the constraint verdicts the change would produce. The spike measures first, on Melian's own tree, what the blast-radius samples carry and how they are capped. Only where the report falls short of the full, located caller list a lens needs does Melian add the missing surface, an uncapped located blast radius or an `impact` twin of `impact_analysis`, to a fork pinned from its own releases and offered upstream. No fork is made before the measurement says one is needed.

Why: The decision this supersedes said upstream had no command-line caller query and planned a fork for `plan-check` and `impact`. Enola's reference documents `enola plan` with `--paths`, `--symbols`, `--patch`, and `--json`, so the fork's scope is at most what `plan` lacks, and a fork carried for nothing is churn against a project that releases every few days.

Supersedes: 2026-10-04-enola.md
