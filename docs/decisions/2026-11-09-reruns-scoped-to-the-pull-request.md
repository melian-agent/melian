# Inventory reruns are scoped to the pull request's own change, and run once

Amends: [docs/decisions/2026-11-07-targeted-mutant-rerun.md](2026-11-07-targeted-mutant-rerun.md), the rerun-all triggers and when the rerun runs

The maintainer ruled on 2026-11-09 that the triggers which rerun every claim apply only to the pull request's own diff, and that the selected rerun runs once, at the final head.

## Why

The targeted rerun reruns every claim when any changed file is a fixture, a snapshot or a spawned script Vitest doesn't track, or a Vitest configuration, a `tsconfig`, a `package.json` or the lockfile. On 2026-11-08 and 2026-11-09, stacked branches merged `main` each time their base moved. Each merge brought in `main`'s lockfile and `package.json` change from [pull request #289](https://github.com/melian-agent/melian/pull/289)'s new dependency, and `main`'s new fixtures. So branches whose own code hadn't changed reran every claim: 769 on [pull request #296](https://github.com/melian-agent/melian/pull/296) after one merge, and 476 on [pull request #294](https://github.com/melian-agent/melian/pull/294). Builders also reran after each fix pass. Each rerun of several hundred claims costs hours.

The rule still earns its place. On #294 it found 115 claims that no longer held. The waste was in what triggered it: a file `main` changed was already proved by its own pull request.

## The rule

- A rerun-all trigger counts only when the pull request's own diff against its own base, `git diff --name-only origin/<base>...HEAD`, holds that file. A stacked pull request's base is its parent's branch, so its parent's changes are never its own.
- A file that changed only by merging `main` triggers nothing by itself. Vitest's `--changed <claim head>` still selects every test a merged module affects, so a kill that `main`'s change broke is still rerun.
- The selected rerun runs once, at the final head after the last merge of `main`, just before the last round. Fix passes prove their own commits' mutants, as the targeted-rerun decision already allows.
- `melian mutants verify` ([issue #240](https://github.com/melian-agent/melian/issues/240)) replaces the hand reruns once the critical paths close.

## What this gives up

A file `main` changed that a test reads without an import edge, such as a fixture from `main` that a branch's test reads, no longer forces a full rerun. A kill it broke surfaces in the merge group's CI only as a test failure, not as a survivor. That's the case the old trigger guarded, accepted here because `main`'s own pull request proved the change.
