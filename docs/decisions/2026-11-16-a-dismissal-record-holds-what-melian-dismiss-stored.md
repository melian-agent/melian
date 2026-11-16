# A dismissal record holds what `melian dismiss` stored

Amends: [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md), rule 2's kinds that come from a command

Status: for [issue #481](https://github.com/melian-agent/melian/issues/481). The coordinator answered the approach on 2026-11-16, on that issue; it is not a ruling.

## Problem

The shared record decision says five kinds "come from a command, never from a review", and a dismissal is one of them. A review exports records, and `melian dismiss` writes none. So a dismissal has to reach the store some other way.

Example: a maintainer dismisses a P2 finding on their laptop, and a builder in a cloud session reads the same record store. The builder's reader has no record of the dismissal, so the finding blocks there, while the laptop's verdict passes.

## Choice

The next round a review exports adds a dismissal record for each finding the findings document holds dismissed with a frozen sighting. The record holds nothing a review decided. Every field comes from what `melian dismiss` stored: the dismisser, the reason, the time, the severity the verdict showed, the frozen sighting and the revision it was seen at, and the accepted trigger and proof. Its time is the dismissal's, never the export's, and its `head` is its own sighting's head, not the head the exporting round reviewed. Its `rounds` list is empty.

So the dismissal still comes from a command: the export writes the command's stored result, and the round neither names the record in its `read` nor decides anything in it. A later round writes the same bytes, and so the same ID, and the store keeps one copy.

A dismissal stored before findings document version 11 holds no frozen sighting, so it gets no record. Another host reads such a finding as new.

## The verification request names each dismissal by its record

A candidate's `dismissed` roots carry the ID of the dismissal record a round exports for each root. The verification request, and so its key, includes those IDs; the verifier's input leaves them out. A host that sees a dismissal an earlier verification was not shown builds another request and verifies again, as rule 5 asks. The verification record lists the IDs in `dismissals`, and a claim's `matches` names only roots it lists. The verification task's input is version 5; a version-4 task has no record IDs, and a candidate with a dismissed root runs again once after the upgrade. One with none keeps its key.

## How a reader applies a dismissal record

`RecordedRound` reads every dismissal record of the changeset that counts, whatever round it reads. The latest by time stands for each finding. The finding reads dismissed when every sighting still meets the record's trigger under the host's reopen rule, `reopens`, at the revision's proving hunks. A record that does not count, or whose trigger a sighting no longer meets, leaves the finding live, never dropped.

The host's round after a dismissal runs no verifier when every finding is dismissed, and its records then hold no claim of an earlier round's verification. A reader that does not count the dismissal would see a live finding with no claim, and the unverified cap would read a P1 as advisory and pass it. So the reader applies the unverified cap only when the round's account names the verifier. That never reads a round as less strict than the host. A dismissed finding's verification, which the host still shows, is absent from the reader's verdict.

## What stays out

A finding the host holds dismissed by inheritance, as a restatement of a dismissed root, reads as live in the reader. Inheriting needs the defect merge, the severity fence and the floors, and errs towards blocking without them.

A record is never withdrawn. A host that reopens a finding stops exporting its record, and the reader reapplies the reopen rule, which covers every reopen the host makes today. A command that withdraws a dismissal by hand would need a record of its own.
