# Issue #481: the reader tests every round outside a dismissal's frontier

For [issue #481](https://github.com/melian-agent/melian/issues/481), on [pull request #575](https://github.com/melian-agent/melian/pull/575). The coordinator chose this on 2026-11-20, after round 2 of the `melian round` workflow found that the reader walked only the read round's chain: a coordinator's answer under rule 7 of [the shared record decision](../decisions/2026-11-13-shared-record-behind-a-store-port.md), not a ruling.

## What changed

The reader took the rounds since a dismissal from the chain back from the round it reads. A round another host wrote without the frontier, which that chain never names, went untested. Example: a dismissal names [R1]. Host B, which never saw R1, writes R2 with `before: []`, citing a hunk the dismissed revision lacks. R3 follows R1 alone. A reader of R3 kept the dismissal, though R2 reopens it.

`roundsSince` in `packages/pipeline/src/recorded-round.ts` now takes every round of the changeset in the set that is neither in the frontier nor an ancestor of a round there, in the set's ID order. `before` serves only to find the frontier's ancestors. A tested round that names a record the set lacks, or follows a round the set lacks that the writer did not hold, still leaves the finding live, and a revision the reader cannot resolve still refuses the round. Its refusals now say "tests a dismissal at round", since the round need not be one the read round follows.

The cut-chain rule this branch restated for the frontier is gone: with no chain walk, every round past a cut is tested. [The frontier decision](../decisions/2026-11-19-a-dismissal-record-names-the-rounds-its-writer-held.md) keeps the maintainer's words of 2026-11-18 beside the reason his rule is met, and `docs/guidelines/pipeline.md` describes the new rule.

The reader may now block where the host that wrote the round read passes. That host holds only the rounds it ran and listed, so it can hold a finding dismissed while a round it never saw reopened it. The set's answer is the one that counts, by rule 7.

## Tests

The test from the coordinator's example, `recorded-round.test.ts`'s "reopens a dismissal on a sibling round another host wrote without its frontier, though the round read never names it", failed on the head before the fix, reading `['passed', false]` where it expects `['findings', true]`, and passes after it. The fixtures' frontiers now hold the rounds their writer held, the first review's included. Four tests that pinned the cut-chain rule now pin the wider test. Two new tests keep a dismissal read at a round that follows a round its writer held and the set lacks, and leave a finding live past a round since that names a record the set lacks.

`review-records-export.test.ts` gains a third property test. Each host keeps a store of its own, and a sync step copies one host's store into another's, so a host can write a round without having seen another's. Its oracle is rule 7 over every store's records: a dismissal no other supersedes holds when every round its writer did not hold reviewed the line beside the finding as the dismissed revision had it. The reader must agree with it on every seed.

- At the default 20 seeds every seed agrees: 11 keep the dismissal and 9 reopen it, in 13 seconds.
- At 300 seeds every seed agrees: 166 keep it and 134 reopen it, in 192 seconds. On 3 seeds, 53, 112 and 198, the reader reopens a dismissal that the host which wrote the round read still holds.
- Against the reader before the fix, at 300 seeds, seeds 112 and 198 keep a dismissal the set reopens, and 39 more reopen one the set keeps, 2 of them (9 and 15) within the default 20. Seed 112 stays as a named case, which pins that the writer passes where the reader blocks.

## Mutants

`2026-11-20-issue-481-sibling-rounds-mutants.json` lists `melian mutants list dddd718b1...HEAD --claims-in packages/pipeline/src/recorded-round.ts`. Of its 26 generated rows, 25 are killed by a named test and 1 is equivalent, the refusal of a round revision `Revision.parseKey` cannot parse, which core's schema never lets through. Each ran against its named test alone, which passed unmutated and failed mutated, at `3c2f44d95`, the commit that dropped the sort. The one that inverts the frontier filter survived the sibling test, where a held round reopens the dismissal too, and is killed by the test of a round its writer held.

The sort on the rounds since is gone: `set.records()` already lists them in ID order, and every order tests the same sightings. Thirteen hand mutants of the new function ran first, at `03a3f29f2`. Five survived the test first named for them. Three fell to the right test: the two new tests and the follows-none test. The sort's went with the sort. One, which leaves the read round out of the check that every round's records are known, is equivalent: a read round that names a record the set lacks is refused before any dismissal is read, and a read round in the frontier follows only rounds the frontier's ancestry holds.
