# A shared reader remembers every hunk a shared round cited

Amends: [the dismissal record decision](2026-11-16-a-dismissal-record-holds-what-melian-dismiss-stored.md), "A dismissal record is never withdrawn" and the rule `RecordedRound` applies a record by

Status: for [issue #481](https://github.com/melian-agent/melian/issues/481). The coordinator answered on 2026-11-18, choosing this design over exporting the host's memory into a record, which the maintainer's ruling of 2026-11-18 keeps off the export seam; that is a coordinator's answer, not a ruling. It is the rule the coordinator has put on [issue #395](https://github.com/melian-agent/melian/issues/395) for the gate.

## Problem

The host remembers every proving hunk a sighting of a dismissed finding cites, and reopens the dismissal when any of them changes. The reader met a dismissal record against the record's own proof and the current sighting's alone, so it forgot the rest.

Example: a finding is dismissed citing hunk A. The next revision's sighting cites A and B, both unchanged, so it stays dismissed, and the host now remembers B. On the third revision B changes and the sighting cites only A. The host reopens the finding and blocks; the reader kept the dismissal and passed. Codex's review of [pull request #575](https://github.com/melian-agent/melian/pull/575) found it.

## Decision

The reader works the memory out from the records it already lists. A dismissal holds for a finding only while every proving hunk that any sighting of that finding in the record set cites, at any revision, is unchanged at the revision being read. The sightings are those of the changeset's lens and check records that count. A dismissal record's own sighting adds nothing, since its trigger's proof already holds every hunk that sighting cites. No record changes shape.

`citedProof` in `packages/pipeline/src/findings.ts` gathers the hunks, and `sharedDismissalHolds` applies the host's reopen rule with them. `RecordedRound` hands each dismissal its `cited` hunks, in its verdict and in `contents`, so a gate that decides sightings itself calls the same function and agrees by construction.

## The limit

A round that was never shared cannot be remembered. If the second revision's round in the example reached no shared store, the reader holds only A and keeps the dismissal where the host reopens it. With every round shared, the reader is at least as strict as the host.

It can be stricter. The host forgets a hunk that changed while the finding stood undismissed; the reader remembers every hunk any shared round cited, before the dismissal too, and so can reopen a dismissal the host keeps. That blocks more, never less.

## Tests

`findings.test.ts` drives the host through the three revisions and reads the third with the hunks of the sightings shared: the host and the reader both read `new`, and without the second revision's sighting the reader reads `dismissed`. `recorded-round.test.ts` pins the same through records: a lens record, and a check record, of another revision citing a hunk the revision read no longer holds reopens the dismissal, and without that record it holds. A record of another changeset adds no hunk, and a dismissal of a finding no shared round sights carries none.
