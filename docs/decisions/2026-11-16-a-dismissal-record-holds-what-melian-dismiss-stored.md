# A dismissal record holds what `melian dismiss` stored

Amends: [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md), rule 2's kinds that come from a command

Status: for [issue #481](https://github.com/melian-agent/melian/issues/481). The coordinator answered the approach on 2026-11-16, on that issue; it is not a ruling. The maintainer ruled on three points the same day, in the coordinator's session, recorded in [the maintainer's ruling of 2026-11-16](https://github.com/melian-agent/melian/issues/481#issuecomment-6910821952) on that issue.

## Problem

The shared record decision says five kinds "come from a command, never from a review", and a dismissal is one of them. A review exports records, and `melian dismiss` writes none. So a dismissal has to reach the store some other way.

Example: a maintainer dismisses a P2 finding on their laptop, and a builder in a cloud session reads the same record store. The builder's reader has no record of the dismissal, so the finding blocks there, while the laptop's verdict passes.

## Choice

The next round a review exports adds a dismissal record for each finding the findings document holds dismissed with a frozen sighting. The record holds nothing a review decided. Every field comes from what `melian dismiss` stored: the dismisser, the reason, the time, the severity the verdict showed, the frozen sighting and the revision it was seen at, and the accepted trigger and proof. Its time is the dismissal's, never the export's, and its `head` is its own sighting's head, not the head the exporting round reviewed. Its `rounds` list is empty.

So the dismissal still comes from a command: the export writes the command's stored result, and the round neither names the record in its `read` nor decides anything in it. A later round writes the same bytes, and so the same ID, and the store keeps one copy.

A dismissal stored before findings document version 11 holds no frozen sighting, so it gets no record. Another host reads such a finding as new.

## The verification request names each dismissal by its record

A candidate's `dismissed` roots carry the ID of the dismissal record a round exports for each root. The verification request, and so its key, includes those IDs; the verifier's input leaves them out. A host that sees a dismissal an earlier verification was not shown builds another request and verifies again, as rule 5 asks. A dismissal replaced while a review runs is such a dismissal, so the same review asks the verifier again, and a restatement carries the dismissal that stands, by [the maintainer's ruling of 2026-11-16](https://github.com/melian-agent/melian/issues/481#issuecomment-6910821952). The verification record lists the IDs in `dismissals`, and a claim's `matches` names only roots it lists. The verification task's input is version 5; a version-4 task has no record IDs, and a candidate with a dismissed root runs again once after the upgrade. One with none keeps its key.

Restatement covers lens findings only. A dismissed static finding is never a root, because its dismissal may have no record to name: a static run that cannot prove it stored none of its tool's text leaves the dismissal unshared, as `unprovenRun`. Without this, a lens claim on that file under the static finding's rule made verification throw, and the review failed. Now the lens claim is verified on its own and the review completes. A dismissed guardrail finding stays a root. [Issue #528](https://github.com/melian-agent/melian/issues/528) will later make `unprovenRun` conditional; `unshared` keeps its meaning then. This is the coordinator's answer of 2026-11-18, not a ruling.

## How a reader applies a dismissal record

`RecordedRound` reads every dismissal record of the changeset that counts, whatever round it reads, less any that another record of the same finding names in `supersedes`. Every dismissal record left standing counts, by rule 7 as the coordinator answered it on [issue #395](https://github.com/melian-agent/melian/issues/395) on 2026-11-17, which this pull request builds in place of build 4; that is a coordinator's answer, not a ruling. Two hosts that each re-dismiss a finding leave one standing record each. The finding reads dismissed when every sighting still meets the trigger of any standing record under the host's reopen rule, `reopens`, at the revision's proving hunks. Of several that hold, the verdict shows the latest, and of two made at one time the one with the greater ID. A record that does not count, or whose trigger a sighting no longer meets, leaves the finding live, never dropped.

The host's round after a dismissal runs no verifier when every finding is dismissed, and its records then hold no claim of an earlier round's verification. A reader that does not count the dismissal would see a live finding with no claim, and the unverified cap would read a P1 as advisory and pass it. So the reader applies the unverified cap only when the round's account names the verifier, by [the maintainer's ruling of 2026-11-16](https://github.com/melian-agent/melian/issues/481#issuecomment-6910821952). That never reads a round as less strict than the host.

## Where a reader differs from the host

Three differences remain, by [the maintainer's ruling of 2026-11-16](https://github.com/melian-agent/melian/issues/481#issuecomment-6910821952); [issue #506](https://github.com/melian-agent/melian/issues/506) closes the first two before build 5.

A dismissed finding carries no earlier verification. The host's round exports a claim only for a verification it ran, and its round after a dismissal runs none. So the reader's verdict shows the finding dismissed with no verification, where the host's shows the verification an earlier round made.

A restatement the host holds dismissed by inheritance reads live. The reader applies a dismissal record only to the finding it names, because inheriting needs the defect merge, the severity fence and the floors. So a reader sees the restatement new and blocking where the host passes it.

A dismissal record is never withdrawn. A host that reopens a finding stops exporting its record, and the reader reapplies the reopen rule to the record it still holds, which covers every reopen the host makes today. A reader would still see the finding dismissed after a command that withdrew a dismissal by hand, and such a command would need a record of its own.
