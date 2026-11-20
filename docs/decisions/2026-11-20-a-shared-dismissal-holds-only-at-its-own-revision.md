# A shared dismissal holds only at the revision it was made at

Supersedes: [the decision that a dismissal record names the rounds its writer held](2026-11-19-a-dismissal-record-names-the-rounds-its-writer-held.md)
Amends: [the decision that a shared reader remembers the hunks cited since a dismissal](2026-11-18-a-shared-reader-remembers-every-cited-hunk.md), everything but its rule that a round names the store's frontier in `before`
Amends: [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md), rule 7's reopen from every sighting in the set, with each revision's proving hunks from git, and its late round of an older revision; and rule 7's "the record reaches the store with the host's next add", for a dismissal made with no store; and rule 9's inheritance the reader computes from the dismissal records and git
Amends: [the decision that a dismissal record is written once](2026-11-18-a-dismissal-record-is-written-once.md), "A dismissal made with no store gets its record at the next review that exports", and "When the store fails", as a reader of shared records now reads that window
Amends: [the decision that a dismissal carries to a restatement](2026-11-08-dismissal-carries-to-restatement.md), inheritance in a reader of shared records

Status: for [issue #481](https://github.com/melian-agent/melian/issues/481), on [pull request #575](https://github.com/melian-agent/melian/pull/575). The maintainer ruled on 2026-11-20, in the coordinator's session, and the ruling is recorded on the pull request in [this comment](https://github.com/melian-agent/melian/pull/575#issuecomment-7030586727).

## Problem

A reader of shared records tried to remember what the host remembers: every hunk a sighting cited since a dismissal, at every revision a round reviewed. Each attempt left a case where the reader kept a dismissal the host reopened, or reopened one the host kept. Each fix added code: a chain of rounds, a rule for a cut chain, a frontier, a git read of every round's revision, and a refusal for a shallow clone.

Example: a finding is dismissed at revision X. A round at revision Y sights it, citing a hunk X never had. The author then pushes back to X's content. Whether a host reopens it depends on which rounds that host ran, and in what order. A reader that sees only the shared records cannot rebuild every host's memory, so it cannot match every host.

## Decision

A shared dismissal holds only for a round at the revision it was made at. It ends once any round has been written at another revision, which the record's `frontier` lets the reader see. The reader needs no hunks from another revision, no git and no memory.

The guarantee: the reader never keeps a dismissal that any host would reopen. The cost the maintainer accepted: a push after a dismissal leaves the finding live in shared reads until someone dismisses it again.

`RecordedRound` reads each dismissal record of the changeset that counts, the latest by time for each finding. The rounds since it are every round of the changeset in the set that is neither in its `frontier` nor an ancestor of a round there, the round read among them. If any of them reviewed another revision, the dismissal has ended. Otherwise each of their sightings of the finding must meet the record's trigger under the host's reopen rule, `reopens`, against the revision's proving hunks. Each must also cite only hunks the revision holds. A sighting that cites a hunk the revision lacks stands for one the host would remember and reopen on, so it ends the dismissal at once. `sharedDismissalHolds` in `packages/pipeline/src/findings.ts` applies both tests. A round since that names a record the set does not hold, or follows a round neither the set nor the writer held, leaves the finding live, since what it cited is unknown.

At one revision every genuine sighting cites only that revision's hunks, so a host that held the dismissal reopens it whenever a sighting there fails the trigger. The reader applies the same test, and fails closed on everything else. So it is never looser than any host.

`contents(revision)` hands an ended dismissal over in `ended`, with the round that ended it and that round's revision. `melian findings --records` prints one line for each: the finding is live again in that round, it was dismissed at another revision, a round reviewed another as after a push, and the command that dismisses it again.

## Inheritance

A reader of shared records computes no inheritance. A finding the host holds dismissed because it restates a dismissed finding reads as live there, new and blocking where the host passes it. Problem: the host decides an inheritance from what it remembers of earlier rounds, the defect merge, the severity fence and the floors. A reader that sees only one revision's records would have to rebuild that memory, which this decision removes. Example: a maintainer dismisses finding A, and a later round at the same revision words the same defect as finding B. The host shows B dismissed, inherited from A. A reader of the shared records shows B blocking.

The cost: a restated finding needs a shared dismissal of its own, though the host already passes it. `restatement.test.ts` pins both sides: the host reads B as inherited, and the reader reads it live. [Issue #506](https://github.com/melian-agent/melian/issues/506) holds the gap open.

## When the store fails

The written-once decision's one gap stands under this reader, narrowed to one revision. A record can reach the store while the host that wrote it records nothing. A reader of a round at the dismissed revision then reads the finding dismissed, while the writing host blocks until `melian dismiss` is run again. A round at any other revision ends the dismissal for the reader too, so the window holds only at the revision it was made at.

## What stays

These clauses of the superseded frontier decision stand:

- `melian dismiss --records` names, in the record's `frontier`, every round of the changeset that the store's one listing holds as the dismissal is made, in ID order. The record is written once, at dismiss.
- A record without `frontier`, which an earlier build wrote, counts as no dismissal, and its finding stays live.
- A dismissal made with no store gets no record. A review names it as unshared, under the code `madeWithoutStore`, and `melian dismiss` says so; to share it, dismiss it again with `--records`. The verification request's key still names such a dismissal, by the ID its record would have with no frontier and no `supersedes`.
- A record found in the store for a dismissal made again is the one the store holds, whatever its frontier.

A round still names in `before` the rounds of its host's previous revision, joined with the store's frontier, and a store that cannot be listed still fails the review before any round is written, as the shared-reader decision says. `before` now serves only to find the frontier's ancestors.

## What goes

The memory across revisions goes: `citedProof`, the `cited` hunks a dismissal carried in `contents`, and the test of a later round's sightings against hunks earlier rounds cited. The per-round git resolution goes with it: `Changeset.resolve` of each round's base and head, and the refusal of a round whose commit a shallow clone lacks. So does the text on a cut chain, since no chain is walked. A shallow clone, and a pull request whose force push lost a round's commits, now read the same as a full checkout.

## Tests

`recorded-round.test.ts` reads a dismissal as ended, naming the round and its revision, once a round reviewed another revision and the author returned to the dismissed one. It ends a dismissal at a retargeted base, at a revision the checkout lacks, and at a later revision the host keeps it at, which is the accepted cost. It reopens an introduced dismissal once a round since at its revision sights the finding as affected with a new trigger, and one whose round since cites a hunk the revision lacks. Its property test drives the host's own lifecycle over seeded histories of re-reviews at the dismissed revision and pushes, and checks the reader never keeps a dismissal the host reopened.

`review-records-export.test.ts` runs hosts with stores of their own that sync late, with re-dismissals. Its oracle is the guarantee: for every dismissal the reader keeps, the host that wrote it still holds it, and so does a host that holds it and then meets, through `upsertFinding`, every round its writer did not hold, in the order they were written. Seeds 9, 112 and 302 stay as named cases. `cli.test.ts` checks the line `melian findings --records` prints for a dismissal a push ended.
