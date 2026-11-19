# A dismissal record names the rounds its writer held

Amends: [the decision that a dismissal record is written once](2026-11-18-a-dismissal-record-is-written-once.md), "A dismissal made with no store gets its record at the next review that exports"
Amends: [the decision that a shared reader remembers the hunks cited since a dismissal](2026-11-18-a-shared-reader-remembers-every-cited-hunk.md), where the reader stops the round chain and what counts as a cut chain

Status: for [issue #481](https://github.com/melian-agent/melian/issues/481), on [pull request #575](https://github.com/melian-agent/melian/pull/575). The coordinator answered on 2026-11-19: a dismissal made with no store exports no record, and the record names a frontier. That is a coordinator's answer, not a ruling. The rule that a cut chain counts the dismissal as nothing is the maintainer's ruling of 2026-11-18, restated here for the frontier.

## Problem

The reader took the rounds since a dismissal from the round chain, and stopped at the rounds of the revision the dismissal's sighting names. A revision is not a time. A round reviewed again at that revision after the dismissal is a round since it, and its sightings can cite a hunk the revision lacks.

Example: a finding is dismissed at revision 1 after round R1. Round R1' then reviews revision 1 again, and its sighting cites hunk B, which revision 1 no longer holds. The host reopens the finding. The reader stopped at R1', since it is of the dismissal's revision, and kept the dismissal.

## Decision

`melian dismiss --records` names, in the record's `frontier`, every round of the changeset that the store's one listing holds as the dismissal is made, in ID order. The reader counts as since the dismissal every round on the chain back from the round it reads that is neither in the frontier nor an ancestor of a round there, whatever its revision.

The field is optional in the schema. A record without it, which an earlier build wrote, counts as no dismissal: its finding stays live. That is the strict direction. No shared store holds such a record yet, so nothing is lost.

Only the writer, as it dismisses, knows what its store held. So a dismissal made with no store gets no record. A review names it as unshared, under the code `madeWithoutStore`, and `melian dismiss` says so. To share it, dismiss it again with `--records`. The verification request's key still names such a dismissal, by the ID its record would have with no frontier and no `supersedes`, so a replaced dismissal still asks the verifier again.

A record found in the store for a dismissal made again is the one the store holds, whatever its frontier, as a record is already found whatever its `supersedes`.

## A cut chain

The maintainer's ruling of 2026-11-18, given in the coordinator's session, is recorded in [the shared-reader decision](2026-11-18-a-shared-reader-remembers-every-cited-hunk.md) in these words: when "any branch of the chain ends, at a round with an empty `before`, before it reaches a round of the dismissal's revision", "the reader counts such a dismissal as nothing". A record now names a frontier, not one revision, so that wording no longer says where a chain should stop. The restatement below is the builder's wording, not the maintainer's; the coordinator agreed it on 2026-11-20 and is putting it to the maintainer.

A round names, in `before`, every round of another revision its store held. It never names a round of its own revision. So a branch of the chain that ends, at a round with an empty `before`, short of the frontier, was cut if the writer held a round of another revision: that round's writer could not have missed it unless its chain was severed. The dismissal then counts as nothing, by the maintainer's ruling of 2026-11-18. A branch that ends at the revision of every round the writer held was not cut, and its rounds count as since the dismissal.

## Each round at its own revision

The host tests each sighting against the hunks of the revision it was seen at. A reader that tests every sighting against the revision it reads misses a reopening. Example: the dismissal accepts hunks in `src/a.ts` and `src/b.ts` at revision X. Revision Y reverts `src/a.ts`, and Y's round sights the finding citing `src/b.ts` alone, so the host reopens it there. Revision Z changes both files again. Tested only at Z, the reader would find both hunks and let the dismissal hold.

So the reader resolves the revision of each round since the dismissal from git, by its base and head, with `Changeset.resolve`, the diff the CLI reads the read round's own revision from. It tests that round's sightings of the finding against the hunks the dismissal accepted and every hunk cited anywhere in the chain, at that revision's hunks, with `sharedDismissalHolds`, the rule it uses for the read round. A sighting that reopens there makes the dismissal count as nothing. A round with no sighting of the finding needs no revision, so its commits are never read. A round after a retarget has another base, and it is tested at its own base and head, never at the read round's. The coordinator chose this on 2026-11-20, after the maintainer said he had no preference among the options; it is the coordinator's choice, not a ruling.

A reader that cannot resolve such a revision refuses the round, as not reviewed, and names why: a commit the checkout lacks, by its hash, as a shallow clone may, or a read with no checkout at all. It never lets the dismissal hold. So `melian findings --records`, and the gate [issue #395](https://github.com/melian-agent/melian/issues/395) builds on this reader, need the repository's history of every round they read past a dismissal.

## Tests

`recorded-round.test.ts` reopens a dismissal once a round after it, at its own revision, cites a hunk the revision lacks. It keeps a dismissal whose writer held the rounds that cited such hunks. It drops one whose record names no frontier, one past a chain that ends short of a round its writer held, and one past a fork with such a branch. A chain that ends at the revision of every held round counts as since. `review-records.test.ts` checks that `made` names only the changeset's rounds, sorted, and finds a held record whatever its frontier. `review-payloads.test.ts` accepts a dismissal with no frontier and refuses one listed out of order or twice. `review-records-export.test.ts` shares no dismissal made with no store, and names it as unshared. `recorded-round.test.ts` also reopens a dismissal at Z once Y, in the example above, lacked a hunk it accepted. It tests a round after a retarget at its own base, which reopens the dismissal when that base took a file the dismissal accepted a hunk in, and keeps it when the base changed only another file. It refuses a round whose chain names a commit the checkout lacks, naming the commit, and one read with no checkout, unless no round since sights the finding.
