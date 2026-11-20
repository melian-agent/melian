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
