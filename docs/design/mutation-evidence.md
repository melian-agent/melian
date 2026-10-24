# Mutation evidence

Planned for milestone 2, plan step 34, with the other-language adapters in milestone 3. [The decision](../decisions/2026-10-24-mutation-evidence-by-enumeration-and-verification.md) holds the exact rules, what it amends, and the numbered list to attack before any build. Each part is tagged: **[Melian's flow]** is the product, **[Building Melian]** this repository's own process.

Problem: a test counts as proof only when it fails with the guard it covers removed, and the only thing that ran the removal was a whole Stryker run, 15 to 70 minutes a round. The `tests` lens named "the mutation every test lets through" in prose, and nobody ran it. Enumeration reached TypeScript and JavaScript alone.

Example: on [pull request #168](https://github.com/melian-agent/melian/pull/168) a builder's hand inventory covered 18% of 242 mutants, and all ten of Stryker's survivors sat in the rest. Once builders enumerated first, six passes left Stryker nothing real to find, and every claim it could check held.

Solution: mutation evidence is a record that a named test killed a named mutant at a named head, made by applying the mutant and running that test. Melian enumerates, a builder or a lens claims, and a verification run checks. The `tests` lens backs each `untested-behaviour` finding with a probe. Stryker leaves Melian's own tiers and stays as an opt-in audit.

## The commands **[Melian's flow]**

`melian mutants list <range|#pr>` enumerates the mutants of the changed production lines into a versioned inventory, without running a test or any head code. `melian mutants sample <inventory>` prints the probes a classified inventory owes, by the deterministic rule of [the sampling decision](../decisions/2026-10-21-builder-inventory-sampling.md). `melian mutants verify <inventory> [--all]` applies each sampled mutant, or every claimed one, runs the named test, and records the outcome in the inventory and in the repository's mutation cache. It exits `0` when every claim held, `1` when one did not or a `new-test` claim still waits, `2` when it could not run. [The CLI guideline](../guidelines/cli.md#commands) gets the rows.

The inventory, `melianMutants: 2`, carries the range, each adapter's identity, the installation identity, and one row per mutant. A row holds its identity fields, the hex SHA-256 of `[file, line, column, endLine, endColumn, mutatorName, replacement]` as `id`, the builder's `claim`, `evidence` and `survivorClasses`, and its `verification`. A `killed` claim's evidence is `{ test: { file, name } }`; an `equivalent` claim's is `{ reason }`. The version-1 inventory with string evidence is refused by `verify`.

## Adapters **[Melian's flow]**

A `MutationAdapter` lists mutants for changed lines, applies one to a file's text, names the command that runs one named test, and classifies an outcome as `killed`, `survived`, `invalid` or `timeout`. The TypeScript adapter uses `@stryker-mutator/instrumenter` as a library in an empty scratch directory and Vitest's JSON reporter for one named test; it never starts Stryker's runner. Other adapters wrap a dedicated tool, cargo-mutants, mutmut, PIT, Stryker.NET or mutant, or fall back to tree-sitter with a fixed operator table, as [issue #170](https://github.com/melian-agent/melian/issues/170) proposes. A repository names its languages and test commands under `mutants.languages` in the committed root `melian.yaml`, the only file that may, since a test command executes.

## Verification **[Melian's flow]**

A verification run executes the head's tests in a scratch worktree, under the leave [the unconfined decision](../decisions/2026-10-14-static-checks-run-unconfined.md) requires: a writer's head or `--trust-head`. `melian mutants verify` is the user's own word for the inventory's head and records leave `reviewer`. A kill is a test that passes unmutated and fails mutated; the baseline runs once per test file per run. A mutant that does not parse or load is `invalid`, never `killed`; a run past `mutants.timeout` is `timeout`. Records live in the mutation cache keyed by head, adapter and installation identity, and are evidence at that head alone.

## The tests lens **[Melian's flow]**

The lens receives the enumeration of its files' changed lines, with each mutant's record at this head, inside the review's boundary under the label `mutants`, bounded to 400 mutants and 64 KiB. Two tools join it: `list_mutants(file)` and `probe_mutant(id, test?)`. A probe without a test runs the tests Vitest relates to the file and names the first that failed. An `untested-behaviour` report names a probed mutant whose record reads `survived`; one naming a killed mutant is refused, and one naming none is refused while a probe is available. The verifier receives the record, may lower a survived finding one step within the fence, and may not refute it. The probe is a third verification executor, `probe`, and its refutation supplies no trust-floor minimum. `budget.probes`, 12 by default at `careful`, bounds a run; a refused probe is noted and does not end the lens.

## Stale kills **[Melian's flow]**

A later change to `b.ts` can make an earlier-killed mutant in `a.ts` survive. The choice: a record is evidence for its exact head and no other, and every claim is verified again at the head the review passes on. Measured on four recent pull requests, 72 to 328 mutants at about 3 seconds a mutant under load, that is 4 to 18 minutes serial, against Stryker's 15 to 70 a round. Re-verifying only claims whose test's import closure changed was rejected: imports are not the only thing a kill depends on, and the list of what else is kept growing.

## Coverage **[Melian's flow]**

Until [the coverage ledger](coverage-and-delta-review.md) lands, adjudication writes a `mutants` check record from the enumeration and the records at the head. Under `mutants.evidence: required`, which Melian's own `melian.yaml` sets, an unverified mutant on a changed production line leaves the review not reviewed, naming the count and the command. Under `advisory`, the default, the record counts. Melian writes it; it joins every manifest without a tier entry, and a `melian.yaml` naming it in a tier or `checks.allowSkip` is refused. The ledger absorbs it: a production line is covered when every mutant on it has a `killed` record at the current head, a settled survivor finding, or a dismissal. The decision names what [pull request #185](https://github.com/melian-agent/melian/pull/185) must change.

## What happens to static.mutation **[Melian's flow]**

It leaves every tier of Melian's `melian.yaml` and stays in the product, unchanged, as an opt-in audit: the one exhaustive run and the only measure of what claims and probes miss. The `forged-mutation-kill` guardrail and the policy rules for Stryker's files stay with it.

## Customers **[Melian's flow]**

The three skills gain a "Prove the tests" section telling a builder agent to list, classify, sample, verify and relay, and never to write a claim as held until `verify` says so. `melian doctor` gains a `mutants` line per configured language naming the adapter, the enumerator's source and version, the test runner and `mutants.evidence`.

## This repository **[Building Melian]**

Briefs use `melian mutants list`, `sample` and `verify` in place of the scripts. The host mutation-only run before a branch's first full round goes, and so does the cold final run. The decision lists each `AGENTS.md` line that changes once this is built; none is edited now.
