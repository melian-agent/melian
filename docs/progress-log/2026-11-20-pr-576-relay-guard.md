[Pull request #576](https://github.com/melian-agent/melian/pull/576) adds `checkApproved`, the guard the relay and the round job's `--check` share, after Melian's round at 01ed40f1 found the relay refused once `main` moved on. [2026-11-18-pr-576-records-relay.md](2026-11-18-pr-576-records-relay.md) tells the rest.

## Mutation inventory

The inventory is [2026-11-20-pr-576-relay-guard-mutants.json](2026-11-20-pr-576-relay-guard-mutants.json), version 2 from `melian mutants list 299439dd...2b898374 --claims-in packages/cli/src/target.ts --claims-in packages/cli/src/relay.ts --claims-in packages/github/src/provider.ts --json --all`. It lists 52 mutants, 38 of them generated: 37 `killed` and 1 `equivalent`.

The first run, at 8e85b8f0, left eight survivors. 2b898374 adds tests that kill seven:

- an approved ID with a character before it, or after it, which only the anchored pattern refuses;
- a head that moved on the pull request alone, and one that differs in the fetched refs alone;
- the retarget refusal naming the default branch.

The eighth was the redundant check that the default branch is undefined, which 2b898374 removes. A ref never equals an absent default.

The equivalent is `target.ts:154`: a git failure in the ancestry check yields `undefined` in place of `false`, and `!undefined` refuses as `!false` does.

Each of the 37 kills ran by hand at 2b898374, against its named test alone. The test passed unmutated first and failed under the mutant. [The runs](2026-11-20-pr-576-relay-guard-mutant-runs.json) record each.

## The host round at 8444d5c7

The host round at 8444d5c7 held on two findings, and this pass fixes both, each from a failing test.

- The provider read the default branch correctly, but no test said so. 81c6dbb2 adds a provider test whose base is `release` on a repository whose default is `main`, and a relay test that refuses that pull request. Both failed under `defaultBranch: data.base.ref` and pass unmutated.
- A fork's job could hand over any check's record, `static.biome` included, which the job holding the keys runs itself. 455779ca gives `RelayRun` the check names a fork may hand over, `headCodeChecks` in the pipeline, today `static.mutation` alone, and refuses a fork's record of any other check. The test that took a fork's `static.biome` record now refuses it. Both new refusal tests failed before the fix.

[2026-11-20-pr-576-handover-mutants.json](2026-11-20-pr-576-handover-mutants.json) is version 2 from `melian mutants list 8444d5c7...455779ca --claims-in packages/pipeline/src/record-relay.ts --claims-in packages/pipeline/src/checks.ts --json --all`. It lists 13 mutants, 10 generated: 9 `killed` and 1 `equivalent`. `packages/cli/src/relay.ts` has no mutant. The equivalent is `record-relay.ts:289`, `some` to `every`: a fork reaches that guard only with a check record, which names one check. Each kill ran by hand at 455779ca, against its named test alone, which passed unmutated first. [The runs](2026-11-20-pr-576-handover-mutant-runs.json) record each.
