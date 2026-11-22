# Issue 395: the merge gate decides from the shared records

Builder agent: [pull request #638](https://github.com/melian-agent/melian/pull/638) adds `melian gate "#N"`, piece (b) of build 4 of step 46. It decides whether a pull request's head may merge into its base tip now. It reads only the shared records on `melian/state`, and writes nothing.

`RecordGate.decide` in `packages/pipeline/src/record-gate.ts` counts every round at the head whose base the tip's history holds. It reads each round's findings under the tip's policy through `RecordedRound.findingsUnder`, whatever policy the round was decided under. Where rounds disagree on a finding, it keeps the strictest resolution, then the lower severity, then the first counted copy.

Coverage comes only from a round of exactly the merge base to the head. Its account must match its tier, and its read must stand as reviewed. A round that replaces another, or names a record of another revision, covers nothing. The gate is not reviewed when a record is missing, when git cannot place a round's base, or when a counted round's records refuse. A dismissal stands only when no counted round holds its finding live, and only for a finding the merge's diff touches.

The facts a round's account is judged on moved from `record-relay.ts` to `review-records.ts`, so the relay and the reader share one copy. The move changes no behaviour. The reader now names each shared dismissal it cannot judge.

## Mutants

The enumerator listed 504 mutants over `a3f6f070...4a7c2f08c`. 406 generated mutants sit in four of the five trust files, and every one carries a claim: 385 killed and 21 equivalent, each with its reason in the inventory, `2026-11-21-issue-395-merge-gate-mutants.json`.

`record-relay.ts` is left out of `claimsIn`. Its one change calls `roundFacts` in place of its own copy, and Stryker makes no mutant of that call. The moved code is proved where it now lives, in `review-records.ts`.

The runs came in passes, each against its named test alone, after that test passed unmutated with one test collected:

- `record-gate.ts` and `gate.ts` ran at 4b236dc5. Neither file has changed since, so those claims carry by mutant ID.
- `recorded-round.ts` changed when #575's head merged, so every one of its mutants ran again at 4a7c2f08c.
- `review-records.ts` ran at 4a7c2f08c.
- The survivors of `record-gate.ts` ran at 91c424094, against the tests that commit added, over the source at 4a7c2f08c.

The first form of the test for the ID tie-break used findings of one severity, and every line-230 mutant survived it. Each round's verdict already arrives sorted by path, severity, line and ID. The test now gives the P0 the middle ID, which the round lists first.

## A fork's head

Round 44870637568 found that the gate counted records for a fork's head, against rule 6 of the shared-record decision. The gate now asks `writerTrust`, as the relay does, and refuses a head that is not a writer's with exit 2. No signing key is pinned yet, so no record counts for such a head.

The new test failed first at c1558877a, with the gate exiting 0, and passes at 087bcb5ec. Its five mutants are in `2026-11-21-issue-395-merge-gate-fork-mutants.json`, over `c1558877a...087bcb5ec`. Each ran at 087bcb5ec against its named test alone, and all five were killed: four by the fork's test, and the one that refuses every head by the test of a writer's head that merges.

## The verifier and the floor

The review of record found two more ways the gate covered what the host would not.

- A round whose verifier did not run covered the merge. The host caps a finding its verifier never judged at advisory and reads the round as not reviewed, yet the gate passed it. Now such a round covers nothing and still hands over its findings; another round whose verifier ran covers. The test failed first at 9ec750f5d with `expected true to be false`, and passes at 9bffbd7ff. With a verifier no model could serve, the round reads not reviewed, its P1 still blocks, and it covers nothing.
- A lens that ran below the floor the base tip now sets still covered. The gate now takes each lens's level from the check in its standing record, which the round's host wrote, and covers the lens only at or above the floor for every path it covers. A run with no level meets none. The test failed first at 9bffbd7ff, covering `lens.contracts` from a careful run under a floor of deep, and passes at 7e3a6da85.

Their mutants are in `2026-11-21-issue-395-merge-gate-verifier-mutants.json`, over `9ec750f5d...9bffbd7ff`, and `2026-11-21-issue-395-merge-gate-floor-mutants.json`, over `9bffbd7ff...7e3a6da85`. Each ran at its own commit against its named test alone, after that test passed unmutated. Of 12 for the verifier, 11 were killed and 1 is equivalent. Of 28 for the floor, 27 were killed and 1 is equivalent. Each equivalent has its reason in the inventory.

## Pooled rounds, the merge's own round, and the gate's words

The maintainer agreed on 2026-11-22, in the coordinator's session, that the gate pools sound rounds, and that the merge's own round keeps every finding. [The decision](../decisions/2026-11-22-the-gate-pools-sound-rounds.md) records both, with the residual he accepted: a failure the head causes only sometimes passes on a clean rerun.

- The merge's own round now keeps every finding it raised, including a pre-existing one in a file the change leaves alone. A round of another revision, such as a stacked parent's, still contributes only findings in the merge's diff. The test that holds a pre-existing P1 at acknowledge in `src/u.ts` failed first at 908d0ae91 with `expected [ true, 'passed', [] ]`, and passes at 994c213a8. The test that drops a stacked parent's finding outside the diff passed before and after.
- The gate's output now names the level a lens ran at and the floor the base tip sets now, and says a new round at that floor is the remedy. A round whose verifier failed is named as such for each check it would have covered. `TierAccount.floor` gives the highest floor of a lens's variants. The tests failed first at 994c213a8, on the old wording and on `account.floor is not a function`, and pass at 5c9417068.

Their mutants are in `2026-11-22-issue-395-merge-gate-own-round-mutants.json`, over `908d0ae91...994c213a8`, and `2026-11-22-issue-395-merge-gate-messages-mutants.json`, over `994c213a8...5c9417068`. Each ran against its named test alone, after that test passed unmutated. All 11 of the merge's own round were killed. Of 49 for the words, 36 were killed at 5c9417068, 8 by the tests ff44e822a adds or changes, and 5 are equivalent, each with its reason in the inventory.

The run found the verifier test hollow: its second round raised no finding, so its account never named the verifier, and three mutants that refuse every round's verifier passed it. It now raises a finding its verifier refutes. The earlier verifier inventory's claims on those lines hold, since a test that does run a verifier killed them.

## Dismissals, the unjudged cap, and a round that covers nothing

Round 12's findings, and the coordinator's answers on approach of 2026-11-22, which it has told the maintainer, led to four changes. [The pooling decision](../decisions/2026-11-22-the-gate-pools-sound-rounds.md) records each.

- The gate asked again for a dismissal of a finding its verdict did not hold live, and named a dismissal twice when two rounds read it. It now lists an ended or unjudged dismissal only for a live finding, and each once. The tests failed first at 2357f8b66, four of them, the first with `expected [ Array(2) ] to deeply equal [ [ '351340b781727cb4' ], [] ]`, and pass at bced4d347.
- A round of the same head at another base, a stacked parent's included, ends a dismissal made on the merge's own round. The gate's message now names that round's revision. The CLI test failed first on the old wording and passes at ec2b9f518.
- A host caps a finding a failed verifier never judged at advisory, and reads the round as not reviewed. Pooling let a second clean round cover every check, so a P1 merged as advisory. The gate now reads such a finding uncapped, whatever the round's verifier check says. The test failed first at ec2b9f518 with `expected [ [ 'src/a.ts', 'advisory' ] ] to deeply equal [ [ 'src/a.ts', 'block' ] ]`, and passes at 6660045dc and 694c82292. 7474c8f44 proves that a host's own reading keeps the cap.
- A round that covers nothing lowers nothing at the gate: its findings count unjudged and uncapped, and it contributes no refutation, no lowering and no coverage. A round of another revision, such as a stacked parent's, counts as covering nothing. The test of a verifier that refuted one claim and then failed showed `expected [ [ 3, 'block' ] ] to deeply equal [ [ 1, 'block' ], [ 3, 'block' ] ]` at 7474c8f44, and its lowering pair failed with line 1 at acknowledge. Both pass at 530f1b44a, and the CLI's message for such a round says to push a fix or dismiss the finding.

The fake model cannot run a verifier outside its accepted route, since `review()` takes no plan, so a verifier that judged one claim and then failed stands in for it.

Their mutants are in `2026-11-22-issue-395-merge-gate-unjudged-mutants.json`, over `2357f8b66...694c82292`, and `2026-11-22-issue-395-merge-gate-covers-nothing-mutants.json`, over `7474c8f44...530f1b44a`. Each ran against its named test alone, after that test passed unmutated. Of 22 for the unjudged cap, 20 were killed at 694c82292 and 2 at 7474c8f44, one by the test that commit adds. Of 14 for a round that covers nothing, 11 were killed at 530f1b44a, 2 by the test the next commit adds, and 1 is equivalent, with its reason in the inventory.
