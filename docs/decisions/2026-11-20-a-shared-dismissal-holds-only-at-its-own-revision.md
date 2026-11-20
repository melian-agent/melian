# A shared dismissal holds only at the revision it was made at

Supersedes: [the decision that a dismissal record names the rounds its writer held](2026-11-19-a-dismissal-record-names-the-rounds-its-writer-held.md)
Amends: [the decision that a shared reader remembers the hunks cited since a dismissal](2026-11-18-a-shared-reader-remembers-every-cited-hunk.md), everything but its rule that a store which cannot be listed fails the review before any round is written, its two rulings of 2026-11-18 included: that a round names the store's frontier in `before`, and that a reader which cannot trace the chain counts the dismissal as nothing
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

`RecordedRound` reads each dismissal record of the changeset that counts, the latest by time for each finding. The rounds since it are every round of the changeset in the set that its `frontier` does not name, the round read among them. If any of them reviewed another revision, the dismissal has ended. Otherwise each of their sightings of the finding must meet the record's trigger under the host's reopen rule, `reopens`, against the revision's proving hunks. Each must also cite only hunks the revision holds. A sighting that cites a hunk the revision lacks stands for one the host would remember and reopen on, so it ends the dismissal at once. `sharedDismissalHolds` in `packages/pipeline/src/findings.ts` applies both tests. A round since that names a record the set does not hold, or follows a round neither the set nor the frontier holds, leaves the finding live, since what it cited is unknown.

At one revision every genuine sighting cites only that revision's hunks, so a host that held the dismissal reopens it whenever a sighting there fails the trigger. The reader applies the same test, and fails closed on everything else. So it is never looser than any host.

`contents(revision)` hands an ended dismissal over in `ended`, with the round that ended it and that round's revision. `melian findings --records` prints one line for each: the finding is live again in that round, it was dismissed at another revision, a round reviewed another as after a push, and the command that dismisses it again.

## Inheritance

A reader of shared records computes no inheritance. A finding the host holds dismissed because it restates a dismissed finding reads as live there, new and blocking where the host passes it. Problem: the host decides an inheritance from what it remembers of earlier rounds, the defect merge, the severity fence and the floors. A reader that sees only one revision's records would have to rebuild that memory, which this decision removes. Example: a maintainer dismisses finding A, and a later round at the same revision words the same defect as finding B. The host shows B dismissed, inherited from A. A reader of the shared records shows B blocking.

The cost: a restated finding needs a shared dismissal of its own, though the host already passes it. `restatement.test.ts` pins both sides: the host reads B as inherited, and the reader reads it live. [Issue #506](https://github.com/melian-agent/melian/issues/506) holds the gap open.

## Two dismissals at once

When two hosts dismiss one finding at once, neither record supersedes the other, so both dismissals stand and decide: the finding reads as dismissed while either holds. Only the latest reason, and its author, is shown. Showing both changes the stored finding's shape, so [issue #621](https://github.com/melian-agent/melian/issues/621) holds it.

## When the store fails

The written-once decision's one gap stands under this reader, narrowed to one revision. A record can reach the store while the host that wrote it records nothing. A reader of a round at the dismissed revision then reads the finding dismissed, while the writing host blocks until `melian dismiss` is run again. A round at any other revision ends the dismissal for the reader too, so the window holds only at the revision it was made at.

## What stays

These clauses of the superseded frontier decision stand:

- `melian dismiss --records` names, in the record's `frontier`, every round of the changeset that the store's one listing holds as the dismissal is made, in ID order. The record is written once, at dismiss.
- The field is optional in the schema. A record without `frontier`, which an earlier build wrote, counts as no dismissal, and its finding stays live. That is the strict direction, and no shared store held such a record when the field arrived.
- Only the writer, as it dismisses, knows what its store held. So a dismissal made with no store gets no record. A review names it as unshared, under the code `madeWithoutStore`, and `melian dismiss` says so; to share it, dismiss it again with `--records`. The verification request's key still names such a dismissal, by the ID its record would have with no frontier and no `supersedes`, so a replaced dismissal still asks the verifier again.
- A record found in the store for a dismissal made again is the one the store holds, whatever its frontier, as a record is already found whatever its `supersedes`.
- The reader may block where the host that wrote the round read passes, since that host holds only the rounds it ran and the ones it listed. The reader's answer is the set's, by rule 7 of the shared record decision, and the set's is the one that counts. The writer dismisses again once it has seen the round that ended the dismissal, if the dismissal still holds.

## A round's `before`

The maintainer ruled on 2026-11-20, in the coordinator's session, to drop [issue #611](https://github.com/melian-agent/melian/issues/611), the job that would have named a round's predecessors for the `melian round` workflow. That retires the shared-reader decision's two rulings of 2026-11-18 on the chain. Its first ruling made a round name the store's frontier in `before`, so a reader could walk back to the dismissal's revision. Its second made a reader that could not walk that far count the dismissal as nothing. Neither is needed now. A dismissal's own `frontier` names every round its writer's store listing held, and the reader tests every round of the changeset outside it.

The writer is unchanged. On every host, with local history or without, `predecessors` in `packages/pipeline/src/review.ts` names in `before` the rounds of the revision that host reviewed before, joined with every round of another revision in the store's listing that no such round names. A store that cannot be listed still fails the review before any round is written. The record relay still refuses a round whose `before` is not empty.

The reader no longer walks `before`. It tests every round of the changeset in the set outside the dismissal's `frontier`, the round read among them. Problem: an earlier form counted as held every round a frontier round named, back along each `before`. Example: a store synced in part holds round M, which a host wrote after round U of another revision, but not U itself. A writer dismisses from that store, so its frontier names M and not U. Once U reaches the set, the walk counted U as held, though the writer never met it, and kept a dismissal that U, a round written at another revision, ends by the maintainer's ruling. The coordinator directed on 2026-11-20 that the reader test every round outside the frontier, in this pull request. Against a frontier `melian dismiss` writes from a whole listing, nothing changes, since that listing holds every round its rounds name.

`before` still decides one thing. A round since that names a round neither the set nor the frontier holds leaves the finding live, since what that round reviewed and cited is unknown. Without that check a round that never reached the set, such as one at another revision, would leave the dismissal standing. So the field stays read, and no issue removes it from the stored shape while this check needs it.

## What goes

The memory across revisions goes: `citedProof`, the `cited` hunks a dismissal carried in `contents`, and the test of a later round's sightings against hunks earlier rounds cited. The per-round git resolution goes with it: `Changeset.resolve` of each round's base and head, and the refusal of a round whose commit a shallow clone lacks. So does the text on a cut chain, since no chain is walked. A shallow clone, and a pull request whose force push lost a round's commits, now read the same as a full checkout.

## The advisory cap

The maintainer agreed on 2026-11-21, in the coordinator's session, to how a reader caps a lens finding no verifier judged; [this comment](https://github.com/melian-agent/melian/pull/575#issuecomment-7052774673) records it. Problem: the host caps such a finding at advisory only when the verifier should have judged it, and leaves a finding it held dismissed out of the verifier's request. A reader that capped every unjudged finding, as it did, capped one the host blocks on once its dismissal does not count for the reader. Example: a maintainer dismisses a P1 with no store. The host never asks the verifier about it, so the finding has no verdict. The reader holds no record of the dismissal, reads the finding live, and capped it at advisory, where the host would block.

The reader caps an unjudged lens finding in two cases, as the host does. The first is a finding the round asked its verifier about, which the verification record lists among its `outcomes` by the ID of the finding that speaks for it. The second is a finding whose every report came from a lens run at a level that does not verify. For that, `RecordedRound` loads every lens the policy commit it already reads defines, as it loads and as the root `melian.yaml` tunes it, which `configsFor` lists the same way. It reads `verify` at each level the lens declares, under the source a run at that level reports. A report whose source names no lens of that exact version, or a level its lens does not declare, leaves its finding uncapped. So does a report also made at a level that verifies. A lens file at the policy that does not load leaves every finding uncapped by level, and the policy lookup fails first when a finding came from a lens. A finding that is neither asked about nor from such a level is left uncapped too.

This rests on the lens version covering `verify`. The version hashes each level's `verify` setting, an explicit one and the default alike, so a lens that changes a level's setting gets a new version, and the reader never reads one version's setting for another's run.

## Tests

`recorded-round.test.ts` reads a dismissal as ended, naming the round and its revision, once a round reviewed another revision and the author returned to the dismissed one. It ends a dismissal at a retargeted base, at a revision the checkout lacks, and at a later revision the host keeps it at, which is the accepted cost. It reopens an introduced dismissal once a round since at its revision sights the finding as affected with a new trigger, and one whose round since cites a hunk the revision lacks. It ends a dismissal at a round of another revision its writer never met, though a round of its frontier names it, and at rounds before a frontier that names only its head. Its property test drives the host's own lifecycle over seeded histories of re-reviews at the dismissed revision and pushes, and checks the reader never keeps a dismissal the host reopened.

`review-records-export.test.ts` runs hosts with stores of their own that sync late, with re-dismissals. Its oracle is the guarantee: for every dismissal the reader keeps, the host that wrote it still holds it, and so does a host that holds it and then meets, through `upsertFinding`, every round its writer did not hold, in the order they were written. Seeds 9, 112 and 302 stay as named cases. `cli.test.ts` checks the line `melian findings --records` prints for a dismissal a push ended.

`recorded-round.test.ts` blocks, as the host would, on a dismissed P1 the verifier never judged, beside a P2 it confirmed, when the dismissal was made with no store, and when the shared dismissal has ended. It caps a quick run's unjudged finding as the host does, with the lens as it loads and as the root's settings tune it. It leaves the finding uncapped when the policy holds no lens of the reporting version, when a lens of that version declares no level of the record's name, and when a verifying level reported it too. `lens.test.ts` checks that a level's `verify` setting changes the lens's version, and that the default and its explicit value give the same version.
