# A mutation proof covers a pass's own commits, one named test at a time

Status: accepted by the maintainer, 2026-11-04.

Amends: [Stryker leaves this repository's review rounds](2026-10-24-stryker-off-the-hot-path.md), the scope and cost of the builder's proof.

## Problem

Builders still spent long stretches on mutation work after Stryker left the rounds. AGENTS.md told them to run `static.mutation` alone before a branch's first full round, a cold Stryker run of half an hour to two hours. Some passes also proved every mutant of the branch, or checked each mutant with a package's whole suite.

Example: the builder of [pull request #256](https://github.com/melian-agent/melian/pull/256) kept a 1,037-mutant ledger for the whole branch, while the coordinator's replay of one fix pass's 30 mutants and 7 variants against their named tests took 52 seconds.

## Decision

- No builder runs `static.mutation` or Stryker before a round. `scripts/enumerate-mutants.mjs` lists Stryker's own mutants, so the inventory already covers what Stryker would try. A reviewer may still opt in, as the amended decision allows.
- A pass proves the mutants of its own commits, enumerated from its parent to its head, not the whole branch.
- Each mutant runs against its named test file alone. The gate runs the whole suite once, after the pass.

The rule that a guard counts as tested only when a failing mutation proves it is unchanged.
