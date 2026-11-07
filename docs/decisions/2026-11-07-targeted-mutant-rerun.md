# Rerun only the mutant claims a later change could affect

Amends: [the mutation proof scope](2026-11-04-mutation-proof-scope.md), the rerun before the last round
Amends: [mutation evidence by enumeration and verification](2026-10-24-mutation-evidence-by-enumeration-and-verification.md), which claims a final head must hold evidence for

## Context

The mutation proof scope decision has a builder rerun every claim of the pull request at its last head, because a later change can let a mutant an earlier pass killed survive. In practice, builders reran every claim at every pass. A full rerun costs about five seconds a mutant: 32 minutes on average, and 45 on [pull request #275](https://github.com/melian-agent/melian/pull/275)'s 549 mutants. Between 5 and 7 November it took about 13 of the 13.6 builder-hours spent on inventories.

It found nothing. Across [#267](https://github.com/melian-agent/melian/pull/267), [#274](https://github.com/melian-agent/melian/pull/274), [#275](https://github.com/melian-agent/melian/pull/275) and [#282](https://github.com/melian-agent/melian/pull/282), 15 full reruns proved no earlier claim wrong. The only claim that changed, on [#289](https://github.com/melian-agent/melian/pull/289), became equivalent after its code changed, and a targeted rerun caught it.

A later change affects an earlier claim only through a file its named test loads: the test itself, the mutated source, or anything either imports. A test can reach a mutant through an imported file, so the test's own file and the mutated file are not enough. The round's design lens showed this: `a.test.ts` kills a mutant in `a.ts` through `b.ts`, and a later change to `b.ts` alone skips the claim. Vitest is the authority for which tests a change affects: `vitest list --filesOnly --changed <ref>` follows its import graph and runs nothing.

## Decision

The maintainer ruled on 2026-11-07. Before the pull request's last round, the builder reruns, at the last head, each earlier claim whose named test file is on `npx vitest list --filesOnly --changed <claim head>`, whose mutated file changed since that head, or whose named test file was changed, renamed or deleted in `git diff --name-status <claim head>..HEAD`; Vitest can't list a test file that no longer exists. Every claim is rerun, without consulting Vitest, when any changed file is not a module Vitest's graph tracks (a JSON fixture, a snapshot or a script a test spawns, in any package), or when a Vitest configuration, a `tsconfig`, a `package.json` or the lockfile changed. A test may read a fixture from another package, and a configuration change can stop Vitest collecting a test that the current configuration's listing then can't show, so both fail closed to the full set. The report says how many claims were selected and how many were not. A final head holds exact-head evidence for every selected claim, and a claim no change could affect keeps its evidence from the head it was proved at; this narrows the exact-head rule of the enumeration-and-verification decision to the claims a change could affect. Every other clause of the amended decision stands: pass-scoped proofs while iterating, named tests alone, exactly one test collected, and the gate run once.

## What this gives up

What remains unselected is a change to a module Vitest tracks that alters a test's runtime reads without an import edge, which the round's lenses see in the diff. The round's design lens found the imported-file, deleted-test, cross-package fixture and configuration cases on this decision's own pull request, and the maintainer ruled to close each, failing closed where Vitest can't decide. A change to Vitest's configuration or to `package.json` makes Vitest list every test file, so every claim reruns, as it should.

## Cost

About 5 to 15 minutes before the last round, against 32 to 45 minutes per full rerun, which saves roughly 12 builder-hours a week at this week's rate.
