# A round's accounting is a record of its own

Amends: [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md), rule 2's kinds a review writes
Amends: [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md), rule 6's kinds the job that runs a head's code may hand over

Status: for [issue #425](https://github.com/melian-agent/melian/issues/425). The maintainer ruled on 2026-11-16, in the coordinator's session, answering "agree" to option B below, which the coordinator put and recommended.

## Problem

A reader that rebuilds a verdict from records needs more than the findings. It needs the tier's check list, the skips the policy allows, the checks the review filled in itself, and which producers' sightings count. Example: a round reads a lens record and a Biome record, and the tier also names `static.tsc`. Without the list, the reader cannot tell a tsc run that left no record, which leaves the round not reviewed, from a tier that never named tsc. Today these facts live only in the adjudication task's input, on the host that ran it.

Three options were put:

- **A.** The reader works the accounting out again from the other records and the base's policy.
- **B.** A record of a kind of its own, written by the host that makes the round, and named in the round's `read`.
- **C.** Widen the round's payload to carry the accounting.

A re-derives what the host already decided, so two hosts can disagree at the edges, as [the ask-the-authority decision](2026-10-12-ask-the-authority.md) warns. C makes the round's key move with every policy fact. B keeps each fact where it was decided.

## Choice

B. A review writes a sixth kind, the account. It holds five lists. `checks` is the tier's checks in tier order, and `records` the IDs of the check and lens records it counts. `filled` is the skipped or failed records the review made itself, such as a lens with no paths. Then come `allowSkip`, and `producers`: each check and version whose sightings count, with the IDs a quick run kept. Each list is sorted and holds each entry once, and core's payload check refuses any other form, so one account has one set of bytes.

The account carries a revision, and its key is the request key of that revision and the records it counts. `filled`, `allowSkip`, `producers` and `checks` stay out of the key, since they follow from those records and the base's policy. The round names the account in its `read`.

Rule 2 now reads: a review writes six kinds, a check's result, a lens run's sightings, a verification, a walkthrough, an account and a round, with optional telemetry.

An account counts only from a writer whose round would count: a store set aside by `counts` sets its accounts aside too. A round whose `read` names no account, or two, or one the set does not hold under the round's changeset and revision, reads not reviewed.

Rule 6 gains a clause. The job that runs a writer's head may hand over an account, as it may a round, under its run's changeset and revision. The job that runs a fork's head never hands one over: it hands over only check results, so an account from it is refused, whatever its shape. The job that holds the key builds a fork's account itself, beside the round. `SharedRecord.refusedFromHeadCode` states the rule in code, for the milestone-3 job to call.

## What stays out, and why

The account holds no lineage. The review plan adds lineage when it marks the lens records at adjudication, from the models each lens finished on, and the plan is the authority for it. The reader asks the plan again.
