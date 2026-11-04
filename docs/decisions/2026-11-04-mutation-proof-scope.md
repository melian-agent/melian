# A mutation proof runs each claim against its named test alone

Status: accepted by the maintainer, 2026-11-04.

Amends: [Stryker leaves this repository's review rounds](2026-10-24-stryker-off-the-hot-path.md), the scope and cost of the builder's proof.
Amends: [mutation evidence by enumeration and verification](2026-10-24-mutation-evidence-by-enumeration-and-verification.md), how a builder's hand-run proof selects a test while `melian mutants verify` is not yet built.

## Problem

Builders still spent long stretches on mutation work after Stryker left the rounds. AGENTS.md told them to run `static.mutation` alone before a branch's first full round, a cold Stryker run of half an hour to two hours. Some passes also checked each mutant with a package's whole suite, and proved the whole branch again at every pass.

Example: the builder of [pull request #256](https://github.com/melian-agent/melian/pull/256) kept a 1,037-mutant ledger for the whole branch, while the coordinator's replay of one fix pass's 30 mutants and 7 variants against their named tests took 52 seconds.

## Decision

- No builder runs `static.mutation` or Stryker before a round. `scripts/enumerate-mutants.mjs` lists Stryker's own mutants, so the inventory already covers what Stryker would try. A reviewer may still opt in, as the amended decision allows.
- While iterating, a pass may prove only its own commits' mutants, enumerated from its parent to its head. Before the pull request's last round, the builder reruns every claim of the whole pull request at that head. A later change can let a mutant an earlier pass killed survive, and the exact-head rule of the amended decision stands.
- Each mutant runs against its named test alone: its file plus its `ancestorTitles` and `title`, as an anchored ` > `-joined pattern, never Vitest's flat full name, which a nested `suite > works` and a top-level `suite works` share. A run counts only if exactly one test was collected. A sibling's failure, or a file that fails to load, is no kill, as the amended decision says. The gate runs the whole suite once, after the pass.

The rule that a guard counts as tested only when a failing mutation proves it is unchanged.
