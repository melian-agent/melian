# Read a pull request's history from its own store

For [pull request #256](https://github.com/melian-agent/melian/pull/256), finding `33830c76c2dc81b9`, an ownership read for `#N` now takes snapshot history only from that pull request's own store. The parent is `bdcf9ef2f7e8b0906a3ee7c7fd81387f55ae9e4e`.

## The change

[The exact-round decision](../decisions/2026-10-18-compare-rounds-exact-rule.md) already keeps each pull request's snapshot in its own store. [The CLI guideline](../guidelines/cli.md#comparisons) now says what each command reads:

- Ownership `#N` reads its own saved history.
- Comparisons and ownership candidates still scan every matching store.
- Stats still reads all saved histories.
- Backlog still reads none.

No decision, schema or mechanism changed. The change is narrow: `ComparisonStores.read` derives the requested changeset through core's `pullRequestChangesetId` and reads only that history when the caller supplies ownership. An explicit histories value and the default keep their behaviour.

## The defect

Valid history for pull request 7 was blocked by pull request 8's newer snapshot. A newer `melian.pull-request-rounds` version 2 in one store stopped the read for another pull request with `CompareError: melian.pull-request-rounds has newer version 2`, raised from `MembershipReader.history`. Pull request 7 never needed that document.

Source inspection found exactly three production callers, and type checking validates them:

- Stats supplies undefined ownership and true histories.
- Backlog uses both defaults.
- `PullRequestComparison.open` supplies ownership.

## Failing before, passing after

The coordinator supplied the regression, and it is preserved. Its test is `ownership reads only its own saved history beside another pull request's future snapshot` in `packages/cli/test/comparison-stores-scope.test.ts`.

- Before the fix, on the unchanged parent, the 17-test file passed 16 and failed that one test with the message above. The receipt is `tmp/pr256-own-history-fix/red-node24-receipt.json`.
- After the fix, all 17 passed. Five focused CLI and pipeline files passed 116 of 116, none skipped.
- Lint and type checking exited 0 on Node 24.18.0.

Own-history and stats refusals still pass, including stats needing another pull request's newer history. Two existing false and default controls now meet a future snapshot and assert complete results. Tests use fake providers and temporary storage, with no network.

## Mutation proof

Enumeration ran against the trusted parent through scratch snapshot `36732555a49e1914518c5682916512bc9a8e7050`. That snapshot holds the source, test and guideline changes, before the first draft of this entry. It listed 14 rows: 13 generated mutants and one configuration-ignored StringLiteral note. None was omitted or left unmutated.

All 13 generated mutants failed their named tests, and none was equivalent. Four supplemental guard removals or inversions also failed. No setup, import or timeout failure counted as proof. Every temporary mutation restored production byte-for-byte in a `finally` block.

`tmp/pr256-own-history-fix/inventory.json` holds the coordinates, classifications, named tests, failure messages and active and restored hashes. Its sibling receipts hold commands, exits, logs and toolchain hashes, and `prove.mjs` is the scratch runner.

## Whole gate

The coordinator ran `npm run check` on the host. It exited 0 with 7,168 passed and 2 skipped across 221 files. It took 514.73 seconds wall, 502.93 seconds in Vitest, on Node 24.18.0, npm 11.19.0 and `maxWorkers` 4. All four bound files were unchanged during the run. The receipt is `tmp/pr256-own-history-fix/host-check-exit.json`.

The gate ran on final evidence snapshot `9b13785fa6468f019005a00e7a347a926e2c023b`. It holds the source, test and guideline files and a draft of this entry. This rewrite follows the gate and records its results. The gate did not run on the rewritten entry, and the snapshot does not contain it. The gate is not a run of a committed head.

## What the proof binds

- Parent: `bdcf9ef2f7e8b0906a3ee7c7fd81387f55ae9e4e`.
- `packages/cli/src/comparison-stores.ts`: `21b89740e68b5ad6adba9468845ad8447e2e399f231ef42b416997efedca551f`. The parent's was `400b2e4156149e495f82af97401ed04c4d770ca035a2e59cafa9e474e99a7c5e`.
- `packages/cli/test/comparison-stores-scope.test.ts`: `9ac2e0da2b2b96433dcb2df89c2aec54787514f3e1fdcd5ef747835ce1b76dd3`. The supplied regression's was `54e023f9d2e8cf4f70e8b129c7294ee5bf41eff0c273e2fbe7397746060c83ce`.
- `docs/guidelines/cli.md`: `cf44f82ff4b65171a9fa9138b0f297bf846565b0c41e9ba60e15dc7df71daf5e`.

The lesson: select the documents each caller needs, and keep the version refusal for the documents it does need.

## What this does not cover

A separate concern about a foreign comparison document is under review. This change does not fix it. It claims no full schema or legacy-fixture validation, and it changes no decision or plan status. Fresh final-head reviews are still to do, and the read-only review of the parent does not review this implementation.
