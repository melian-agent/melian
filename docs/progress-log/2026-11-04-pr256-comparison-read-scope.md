# Read only the stored data each comparison command needs

For [pull request #256](https://github.com/melian-agent/melian/pull/256), `melian compare stats` and `melian compare backlog` now read only the stored data they use.

## The contract

[The exact-round decision](../decisions/2026-10-18-compare-rounds-exact-rule.md) has stats read the saved membership snapshot offline for the unattributed count. [The CLI guideline](../guidelines/cli.md#comparisons) now states the scope:

- Backlog reads comparison entries only.
- Stats reads comparison entries and the saved membership histories.
- Neither reads publication ownership or candidate rounds.
- `#N` commands keep complete ownership reads, with candidates and snapshots.
- Unsupported or corrupt data that a command needs still refuses that command.

## The defect

The scan read candidate ownership and publisher data that stats did not use, and backlog also read membership snapshots. A single unrelated document of a newer version could block either command.

Example: a clone holds valid comparisons and one `melian.publisher` document at version 4, which this build does not support. Stats and backlog both stopped with `melian: melian.publisher has newer version 4`. A `melian.pull-request-rounds` snapshot at version 2 stopped backlog the same way. The comparisons were readable, and the command did not need the document.

## The fix

`ComparisonStores.read` in `packages/cli/src/comparison-stores.ts` now reads candidates only when the caller supplies ownership. Its histories parameter defaults to the same condition. Stats asks for histories explicitly, which keeps its nonzero unattributed-round count. Backlog asks for neither. `PullRequestComparison` supplies ownership, so `#N` keeps its full reads. `packages/cli/src/compare.ts` carries the two call sites.

No schema, policy, mechanism, dependency or configuration changed. Storage closing, ENOENT-only absence, scripted isolation and strict refusals on needed data keep their existing paths.

## Failing before, passing after

The tests are in `packages/cli/test/comparison-stores-scope.test.ts`. Each one uses a fresh temporary Git repository and SQLite database. It writes through the production comparison import, adjudication and membership writers, closes them, and reopens through the CLI. A refusal test marks exactly one document kind with a future version. A corrupt-comparison control keeps the current version and nulls the comparisons value. No provider, key or network is used.

- Before, on parent `dff453f3d89b9e5578cced063ca147d4db6ea46b`: 10 passed and 5 failed, as expected. Three failures are the defect regressions, with the two messages above. Two assert the narrower scan default and its explicit override. None was a fixture, import, setup or timeout error.
- After: 15 of 15 passed, none skipped.
- Relevant CLI files: nine files, 221 of 221 passed, none skipped. They are the comparison-stores scope file and the compare, main and pull-request comparison and export suites.
- Lint and type checking exited 0 on Node 24.18.0 and npm 11.19.0.

The tests assert complete values: the full stats output, the exact owed golden, complete candidate values, both saved histories and complete comparison entries. The unattributed round has a head absent from the GitHub answer, and the count is exactly one. Stats still refuses a future snapshot. Both commands still refuse a future or corrupt comparison. Ownership scans still refuse unsupported publisher and snapshot data.

## Manual mutation proof

The enumeration of the production-source snapshot lists 11 generated mutants, none omitted or ignored. Every one was applied by hand at its enumerated coordinates and failed its named test with an assertion. None failed through setup, import or timeout. None survived, and none was called equivalent or retried.

Three supplemental variants were also killed:

- Dropping the stats histories request fails the nonzero count and the required-snapshot refusal.
- Loading candidates for stats fails the future-publisher test.
- Loading histories for backlog fails the future-snapshot test.

## Whole gate

- Host: `npm run check` exited 0 with 7,166 passed and 2 skipped across 221 files, in 436.40 seconds on Node 24.18.0 and npm 11.19.0. The coordinator ran it on the exact source, test and guideline bytes bound below, before this entry existed. It is not a run of a committed head.
- Sandbox: not run for this change. The prior pass showed the sandbox fails on known Git and `ps` restrictions, so the host gate is the whole-gate evidence. The earlier 7,151 result is not carried forward.

## What the proof binds

- Parent: `dff453f3d89b9e5578cced063ca147d4db6ea46b`.
- Source snapshot `c3919ababdf600c527b12ce959c40b61cffadbe0` holds the two production files. It excludes the new test, which is bound by its own hash.
- `packages/cli/src/comparison-stores.ts`: `400b2e4156149e495f82af97401ed04c4d770ca035a2e59cafa9e474e99a7c5e`.
- `packages/cli/src/compare.ts`: `21820a64bdcaa62619376b93cd753cb36c2533a84597a763943b5bfbed44677c`.
- `packages/cli/test/comparison-stores-scope.test.ts`: `189b5619d808fb77aca9a5c6dff84addc12878e17a652d3e19354ad637c88f31`.
- `docs/guidelines/cli.md`: `03b66914e309a8738bf0b1da8d9aa6b1788c420764b554bd48490c30670890e8`.

No design decision or plan status changed. The prior retention fix and its progress entry are unchanged. This pass reran no historical proof. Fresh final-head reviews and the final query-test fix are still to do.
