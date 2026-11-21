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
