[Pull request #576](https://github.com/melian-agent/melian/pull/576), for [issue #397](https://github.com/melian-agent/melian/issues/397), adds a round's shared records to the `melian/state` branch. `melian records relay` checks the directory store a round's job left, whole, and the `melian round` workflow's new `record` job runs it.

## Review fixes

Melian's first round, at 41a33949, raised three findings beyond the policy notices on the workflow and AGENTS.md:

- The round job uploaded the records folder after checking it, so a step between could add a file the relay never saw. 3c316cf0 checks a copy and uploads that copy.
- The `record` job refused to run once `main` had moved, so a merge during a round lost its records. 6c75f6e4 gives it the report job's first step, which lets a first attempt carry on, and adds a decision that amends the round-report decision for this job.
- The relay took free-text fields its payload schemas do not close. [Pull request #551](https://github.com/melian-agent/melian/pull/551) moves those rules into core's payload schema, and a test held as `it.fails` in `record-relay-schema.test.ts` turns once that lands.

Codex's adversarial review and the review of record found three more, each fixed with its test first:

- b593367a: an empty kind or slot folder counted against no bound, so the relay now refuses one.
- e2f3f428: an account could count a record its round does not read.
- 158eaafe: an account's producers were not closed to the base's tier.

## Mutation inventory

The inventory is [2026-11-18-pr-576-records-relay-mutants.json](2026-11-18-pr-576-records-relay-mutants.json), version 2 from `melian mutants list fdcad151...f6f561f9 --claims-in packages/pipeline/src/record-relay.ts --claims-in packages/cli/src/relay.ts --claims-in packages/cli/src/target.ts --json --all`. It lists 561 mutants, 370 of them generated in the three files that guard trust: 329 `killed`, 37 `new-test` and 4 `equivalent`.

Every generated mutant first ran against its package's relay tests, which found 41 survivors. f6f561f9 adds tests that kill 37 of them:

- the store tree: a slot or file name with a prefix or suffix, a kind folder named with a dot, a file where a folder goes, a file in `tmp`, and a folder beside `changesets`;
- a root the relay cannot list;
- bytes that are not UTF-8, refused before they are read as a record;
- a file that vanishes while the relay measures or reads it, in `record-relay-io.test.ts` with a mocked file system;
- which record a refusal names in an empty batch, a batch with no round and a batch with two;
- records under a round's ID, a check's key or a lens run's key that the round never names;
- in the CLI: a target that is no pull request, a base whose pull-request stage names another tier, an error from outside the store, and a second relay of one batch.

The four equivalents:

- `relay.ts:68`, an emptied `finally`: the CLI ends after one relay, and a second relay in the same process opens the store again.
- `record-relay.ts:95`: `RelayRefusal` declares `recordCode` as a class field, so every refusal already holds it.
- `record-relay.ts:113`: the only reader of a fact's cause asks whether it is `noProductionLines`.
- `record-relay.ts:218`: `TierAccount.refusal` treats a triage of `undefined` as absent.

Each of the 366 claimed kills ran by hand at f6f561f9 against its named test alone, which passed unmutated first, and failed under every mutant; [the runs](2026-11-18-pr-576-records-relay-mutant-runs.json) record each. `node scripts/enumerate-mutants.mjs --sample` reads the inventory.

## After pull request #551

The merge of `main` at f9862b6f brought core's closed payload schemas. The expected-fail test now passes as a plain one, and the relay's fixtures name versions those schemas accept. Melian's round at 4d259091 raised two acknowledge findings beyond the policy notices:

- 791958de: the snapshot-ID test also planted a receipt the schema refuses, so it passed with the ID rule removed. Its record now differs from an accepted one in the ID alone, and it fails with the rule removed.
- The checked records stay writable until the upload. The decision on the `record` job now says why nothing can write them: the head's code runs only in the probe sandbox, and Biome and tsc run no head code.

A coordinator's question asked whether the push still finds `gh auth setup-git`'s credential helper. Two tests in `packages/cli/test/relay.test.ts` push to an HTTP origin that demands a credential, with and without the helper in `$HOME/.gitconfig`. The positive test fails when state-git sets `GIT_CONFIG_GLOBAL=/dev/null` or passes `-c credential.helper=`. Both pass on a merge with pull request #592's head, ee37b1f7.

## After main moves past the approved base

Melian's round at 01ed40f1 found that the relay refused once `main` moved on from the base the gate approved, so a merge during a round lost the round's records. 91b1041c adds `checkApproved`, one guard for the relay and the round job's `--check`, and reads policy from the approved base. [The decision](../decisions/2026-11-18-round-records-relay-after-main-moves.md#which-base-the-relay-checks-and-whose-policy-it-reads) says why that commit and not the tip.

The tests in `packages/cli/test/relay.test.ts` failed before the fix with "pull request #7 is at base … not the expected base … so nothing was relayed", and passed after it. An agent briefed with the cases alone wrote `packages/cli/test/relay-approved.test.ts` against a stub that always throws: 4 of its 13 tests failed there, the cases that should relay, and all 13 pass against the guard.

The attacking tests found that a base retargeted to another branch that still holds the approved base would relay. The coordinator answered that such a pull request names a round the workflow would no longer run. The next commit refuses it: GitHub's provider now reports the default branch from the pull request's own read, and the guard compares the base branch with it. Its two tests failed before the fix, as "promise resolved instead of rejecting", and pass after it.

Melian's round at aa4c6631 found that the relay takes a round's records only once the round closes, where the shared-record decision adds them as tasks finish. The maintainer ruled on 2026-11-20 to accept it for Actions rounds, and [the amendment](../decisions/2026-11-20-an-actions-round-shares-its-records-when-it-closes.md) records why and what a cut round loses. [Issue #602](https://github.com/melian-agent/melian/issues/602) holds partial relays.
