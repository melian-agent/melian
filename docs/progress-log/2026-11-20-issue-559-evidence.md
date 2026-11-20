# A valid miss keeps the conversations behind it

[Issue #559](https://github.com/melian-agent/melian/issues/559), item 3. When `melian compare adjudicate` judges an external finding a valid miss, Melian copies the round's conversations that could have caught it into the clone's evidence directory, and `melian compare evidence` prints them. [The decision](../decisions/2026-11-20-miss-evidence-is-kept.md) sets out the rules and amends store retention.

- 28ec6654e adds `evidence.budget`, 1 GiB by default, read only from the root `melian.yaml` or the user's preferences.
- 2aa63cef6 adds `EvidenceStore` and `MissEvidence` in the pipeline, `CloneEvidence` in the CLI, the copy on a valid miss and `melian compare evidence`.
- ba0d974bf adds doctor's `evidence` line and makes `melian store prune` keep `evidence/` and count its bytes.
- d79f365a6 moves the choice of stages to `MissEvidence.stagesAt` and the ownership check into `CompareHarness.evidence`. A round counts as the run's owner only when the review index's adjudication task is one of the round's tasks.
- aabaf0c01 adds the tests the mutation run asked for, and takes the base and head from the round.

## Not built

`melian store prune --apply` does not remove evidence 90 days after a merge. No code reads a pull request's merge time, and the retention decision requires its plan-to-removal races closed before prune removes anything durable. The decision records it as a question for the coordinator.

## Tests first

Each rule added after its code started from a failing test:

- The budget's config tests failed 4 of 267, with `expected undefined to deeply equal { budget: 1073741824 }`, and passed 267 of 267.
- Doctor's test failed 1 of 6 and then passed.
- The prune tests failed 2 of 76, with `expected StorePrune{ …(5) } to match object`, and passed 76 of 76.
- The CLI store tests failed 3 of 20 and then passed 48 of 48 across three files.

The store, gather and CLI rules were written before their tests. The mutation runs below stand in for their failing runs: the first run at 2aa63cef6 left 99 survivors, and each new test was written to kill one, then confirmed against that mutant.

## Mutation inventory

[The inventory](2026-11-20-issue-559-evidence-mutants.json) is version 2, from `melian mutants list c2e68c4e7...HEAD --claims-in packages/pipeline/src/evidence.ts --claims-in packages/pipeline/src/store-prune.ts --claims-in packages/pipeline/src/compare.ts --json --all` at aabaf0c01. It lists 647 mutants. The three claimed files hold 335 generated and 56 ignored. Of the 335, 325 are `killed` and 10 are `equivalent`, each with its reason.

Each kill ran by hand against its named test alone. The test was matched by its anchored title, collected exactly once, and passed unmutated first. 294 ran at aabaf0c01. The other 31 ran at d79f365a6, in `compare.ts` and `store-prune.ts`, and carry over because neither file nor any named test changed after. [The runs](2026-11-20-issue-559-evidence-mutant-runs.json) record each result. The worktree's source was clean after every run.

`packages/cli` files are outside the claims. The CLI tests in `packages/cli/test/compare-evidence.test.ts` cover them.

Timing: mutants 3 × 150 min; other 1 × 30 min (unit and CLI test runs).
