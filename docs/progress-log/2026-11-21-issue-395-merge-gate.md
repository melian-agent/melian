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
