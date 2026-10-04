# Enola caller query

Choice: Constraint verdicts for a change come from `enola plan --json`, the command-line twin of the `plan_check` MCP tool on the same code path. Callers do not: its blast-radius samples are names only, capped at twenty by a constant, and one hop deep. Callers come from `enola impact --json`, the command-line twin of `impact_analysis`, which Melian adds to a fork of Enola, pins from the fork's releases, and offers upstream; the fork is a bridge until mainline carries it. The upstream pull request's branch is based on upstream's main; the fork's release branch is the pinned tag plus those commits and the fork's own release workflow. Melian runs a fork binary with its update check disabled and never runs its upgrade command, since both point at upstream.

Why: The decision this supersedes said upstream had no command-line caller query at all and planned a fork for `plan-check` too. Enola's reference documents `enola plan` with `--paths`, `--symbols`, `--patch`, and `--json`, and its source, read at v0.4.26, shows what that report carries, so the fork is scoped to the one command that is missing.

Supersedes: 2026-10-04-enola.md
