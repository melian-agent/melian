# A dismissal record is written once, when the dismissal is made

Amends: [the dismissal record decision](2026-11-16-a-dismissal-record-holds-what-melian-dismiss-stored.md), "What a dismissal record supersedes"

Status: for [issue #481](https://github.com/melian-agent/melian/issues/481). The coordinator answered on 2026-11-18, choosing this design, option (c), without a rule that reads the dismisser's own history; that is a coordinator's answer, not a ruling. It builds rule 7 of [issue #395](https://github.com/melian-agent/melian/issues/395), as the coordinator answered it on 2026-11-17.

## Problem

The dismissal record decision had each export fill a dismissal record's `supersedes` from the store the exporting review listed. So the record of one dismissal was rebuilt on every export, from whatever that host's store held at the time. A host that kept an old dismissal could set it standing again.

Example: host A dismisses a finding and exports its record, K. Host B imports K, replaces the dismissal, and exports R, which supersedes K. Host A imports R and reviews again. A still holds its first dismissal, so its export builds that dismissal's record from a listing holding K and R, and it supersedes R. Now R stands nowhere, and the reason B replaced is the one that stands. Codex's review of [pull request #551](https://github.com/melian-agent/melian/pull/551) found it, and `review-records.test.ts` reproduced it.

## Decision

A dismissal's record is written once, when the dismissal is made and the dismisser names a store: `melian dismiss --records dir:<path>`. Its `supersedes` names the dismissals of that finding and changeset that stand in the store's one listing at that moment, those no other record there supersedes. It never names itself.

An export, and the verification request's key, look up the record the store holds for a dismissal, by its bytes without `supersedes`, and never rebuild one that exists. An export writes nothing for a dismissal whose record the store holds already. A record an earlier build exported, with the `supersedes` its export computed, is found the same way and kept as it is.

A dismissal made with no store gets its record at the next review that exports, and that record supersedes nothing.

## The limit

A dismissal made without a store supersedes nothing: not another host's, and not this host's own earlier one once that reached the store. The earlier dismissal keeps standing beside it, and a reader keeps the finding dismissed while either holds, under the reason of whichever it shows. Superseding still only removes dismissals from what stands, so the gate grows no looser than the dismissals people made. `melian dismiss` without `--records` says so. Build 4's plan gives `dismiss` the shared store by default.

A `supersedes` reading the dismisser's own history was weighed and rejected: the findings document keeps the reason and time of a replaced dismissal, but not its trigger, so it cannot rebuild the record the store holds.

## What changes elsewhere

A later import no longer changes the ID of a record the store holds, since nothing rebuilds it. So the next review no longer asks the verifier again for an import alone, and the identity guideline's verification-request row drops that cost. A dismissal replaced since the last review still gets a new record, and so a new key, as it did.

`melian dismiss --records` writes nothing unless the base's `melian.yaml` writes `trust.writers: true` out, as `review --records` does, and it refuses before recording the dismissal. A dismissal of a static finding that cannot prove its run stored none of its tool's text stays unshared, as `unprovenRun`, and `dismiss` names it as `review` does.

## Tests

`review-records.test.ts` pins the stale host: the record a host exports again is the one it kept, and the other host's replacement stays the only standing one. `review-records-export.test.ts` pins a dismissal made with the store superseding the one it replaced, with the next review writing nothing; a second review writing nothing for a record the store holds; a record from an earlier build kept as it is; and a dismissal made with no store, which leaves both standing. `restatement.test.ts` pins the verification naming the record a dismissal made with the store wrote, which supersedes another host's dismissal the store held.
