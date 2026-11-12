# The final hand rerun is waived until `melian mutants verify` lands

Amends: [docs/decisions/2026-11-09-reruns-scoped-to-the-pull-request.md](2026-11-09-reruns-scoped-to-the-pull-request.md), the final rerun
Amends: [docs/decisions/2026-11-07-targeted-mutant-rerun.md](2026-11-07-targeted-mutant-rerun.md), the rerun before the last round
Amends: [docs/decisions/2026-11-04-mutation-proof-scope.md](2026-11-04-mutation-proof-scope.md), the rerun of every claim at the last head

The maintainer ruled on 2026-11-10 that the final hand rerun of a pull request's mutation inventory is waived until `melian mutants verify` ([issue #240](https://github.com/melian-agent/melian/issues/240)) replaces it.

## Why

A builder runs every selected claim by hand, one mutant at a time against its named test. When a pull request's own change touches a module most tests import, nearly every claim is selected. [Pull request #310](https://github.com/melian-agent/melian/pull/310) selected 689 of 692 claims after its fixes changed `core/src/git.ts`, about 3.5 hours of serial work in the builder's session. That cost recurs on every lane, and scoping the selection to the pull request's own diff did not remove it.

## The rule

- Each fix pass enumerates and runs its own commits' mutants, as before. That is the pull request's proof.
- The final rerun of earlier claims at the final head is not run by hand.
- [Issue #240](https://github.com/melian-agent/melian/issues/240) builds the replacement: a `melian mutants verify` job in Actions, sharded across runners, that runs Stryker over the pull request's changed lines with per-test coverage and an incremental cache seeded from `main`. The tool proves kills itself; builders justify only survivors. When it lands, it runs once on the final head beside the round, and this waiver ends.

## What this gives up

A later change can let a mutant an earlier pass killed survive, and nothing reruns that claim before merge. The pass that made the later change still proves its own mutants, and the lenses' `untested-behaviour` findings still read the diff.
