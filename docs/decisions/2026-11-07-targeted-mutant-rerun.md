# Rerun only the mutant claims a later change could affect

Amends: [the mutation proof scope](2026-11-04-mutation-proof-scope.md), the rerun before the last round

## Context

The mutation proof scope decision has a builder rerun every claim of the pull request at its last head, because a later change can let a mutant an earlier pass killed survive. In practice, builders reran every claim at every pass. A full rerun costs about five seconds a mutant: 32 minutes on average, and 45 on [pull request #275](https://github.com/melian-agent/melian/pull/275)'s 549 mutants. Between 5 and 7 November it took about 13 of the 13.6 builder-hours spent on inventories.

It found nothing. Across [#267](https://github.com/melian-agent/melian/pull/267), [#274](https://github.com/melian-agent/melian/pull/274), [#275](https://github.com/melian-agent/melian/pull/275) and [#282](https://github.com/melian-agent/melian/pull/282), 15 full reruns proved no earlier claim wrong. The only claim that changed, on [#289](https://github.com/melian-agent/melian/pull/289), became equivalent after its code changed, and a targeted rerun caught it.

A later change can affect an earlier claim in only two ways: it changes the named test that killed the mutant, or it changes the source file the mutant sits in. A claim whose two files are unchanged since it was proved gives the same result again.

## Decision

The maintainer ruled on 2026-11-07. Before the pull request's last round, the builder reruns, at the last head, each earlier claim whose named test file or mutated source file changed since the head the claim was proved at. It selects them with `git diff --name-only <claim head>..HEAD`, and the report says how many claims were selected and how many were not. Every other clause of the amended decision stands: pass-scoped proofs while iterating, named tests alone, exactly one test collected, and the gate run once.

## What this gives up

A claim whose mutated file and named test are both unchanged, but whose result depends on another file that changed, such as a shared helper or a fixture, is not rerun. Such a change shows up in the diff and in the round's lenses. If it ever lets a claim go stale, the selection widens to the files the named test imports.

## Cost

About 5 to 15 minutes before the last round, against 32 to 45 minutes per full rerun, which saves roughly 12 builder-hours a week at this week's rate.
