# A shared reader remembers the hunks cited since a dismissal

Amends: [the dismissal record decision](2026-11-16-a-dismissal-record-holds-what-melian-dismiss-stored.md), "A dismissal record is never withdrawn" and the rule `RecordedRound` applies a record by

Status: for [issue #481](https://github.com/melian-agent/melian/issues/481). The coordinator answered on 2026-11-18, choosing this design over exporting the host's memory into a record, which the maintainer's ruling of 2026-11-18 keeps off the export seam; that is a coordinator's answer, not a ruling. The coordinator corrected the rule the same day, after Codex's second review, so that the memory belongs to a standing dismissal and starts at it. It is the rule the coordinator has put on [issue #395](https://github.com/melian-agent/melian/issues/395) for the gate.

## Problem

The host remembers every proving hunk a sighting of a dismissed finding cites, and reopens the dismissal when any of them changes. The reader met a dismissal record against the record's own proof and the current sighting's alone, so it forgot the rest.

Example: a finding is dismissed citing hunk A. The next revision's sighting cites A and B, both unchanged, so it stays dismissed, and the host now remembers B. On the third revision B changes and the sighting cites only A. The host reopens the finding and blocks; the reader kept the dismissal and passed. Codex's review of [pull request #575](https://github.com/melian-agent/melian/pull/575) found it.

## Decision

The reader works the memory out from the records it already lists, and the memory belongs to a standing dismissal, not to its finding. A dismissal holds only while every proving hunk cited by a sighting of its finding, in a lens or check record a counting round names, is unchanged at the revision being read. Only rounds since the dismissal count. The reader takes them from the round chain: from the round it reads, back along each round's `before`, stopping at the rounds of the revision the dismissal's sighting names, which it leaves out. A dismissal record's own sighting adds nothing, since its trigger's proof already holds every hunk that sighting cites. No record changes shape.

The host clears its memory when a finding reopens, and a dismissal made after that starts from what the host has since seen. A memory kept for the finding, for all time, would make such a dismissal reopen at every revision after, so the gate could never pass it again. Codex's second review of [pull request #575](https://github.com/melian-agent/melian/pull/575) found that, in the narrower form of a lens record exported before its review died, which no round names.

`citedProof` in `packages/pipeline/src/findings.ts` gathers the hunks, and `sharedDismissalHolds` applies the host's reopen rule with them. `RecordedRound` hands each dismissal its `cited` hunks, in its verdict and in `contents`, so a gate that decides sightings itself calls the same function and agrees by construction.

## A broken chain

When the chain names a round the set does not hold, or a round of another changeset, or a round names a record the set does not hold, the reader cannot know what that round cited. The dismissal then counts for nothing, and its finding stays live. That is the strict direction: it blocks more, never less. A chain that begins after the dismissal's revision is taken whole, which is strict too.

## The limit

A round that was never shared cannot be remembered, and neither can a record no round names. If the second revision's round in the example reached no shared store, the reader holds only A and keeps the dismissal where the host reopens it. With every round shared, the reader is at least as strict as the host.

It can be stricter. The host drops a hunk that changed while the finding stood undismissed; the reader remembers every hunk a round since the dismissal cited. That blocks more, never less.

## Tests

`findings.test.ts` drives the host through the three revisions and reads the third with the hunks of the sightings shared: the host and the reader both read `new`, and without the second revision's sighting the reader reads `dismissed`. `recorded-round.test.ts` pins the rule through records and rounds. A lens record, and a check record, that a round after the dismissal names and that cite a hunk the revision no longer holds reopen it. A record no round names reopens nothing. A dismissal made again after that round, or at the revision read, holds. A chain that names a round the set lacks, a round whose record the set lacks, or a round of another changeset leaves the finding live.
