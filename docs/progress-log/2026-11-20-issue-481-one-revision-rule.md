# Issue #481: a shared dismissal holds only at its own revision

For [issue #481](https://github.com/melian-agent/melian/issues/481), on [pull request #575](https://github.com/melian-agent/melian/pull/575).

The maintainer ruled on 2026-11-20, in the coordinator's session, that a shared dismissal holds only for a round at the revision it was made at, and ends once any round has been written at another revision. [The ruling is on the pull request](https://github.com/melian-agent/melian/pull/575#issuecomment-7030586727). [The decision](../decisions/2026-11-20-a-shared-dismissal-holds-only-at-its-own-revision.md) records it, supersedes the frontier decision, and amends the shared-record, cited-hunk and written-once decisions where their clauses no longer hold.

## What changed

`RecordedRound.contents` is synchronous again and takes no checkout. A dismissal whose rounds since include one at another revision is handed over in `ended`, naming that round and its revision, and `melian findings --records` prints one line for it, saying a push ended it and how to dismiss it again. At its own revision a dismissal holds while every sighting since meets its trigger and cites only hunks the revision holds, which `sharedDismissalHolds` checks.

The memory across revisions went: `citedProof`, the hunks a dismissal carried, the per-round `Changeset.resolve`, the shallow-clone refusal and the cut-chain text. Across `packages/pipeline/src` and `packages/cli/src`, since `d1685423b`, 119 lines went and 80 came.

The read round now counts among the rounds since, as the decision says, and two fallbacks for values a round always has went with the mutants that showed them dead.

## Failing tests first

`82b8a17f8` reproduced the reader's two disagreements with the host on cited hunks. `dc3da6bf6` added the test that a dismissal ends once a round reviews another revision. Against the head before the fix it failed:

```
× reads a dismissal as ended, naming the round, once a round reviewed another revision and the author returned to the dismissed one
AssertionError: expected 'tests a dismissal at round 97e80f0237…' to deeply equal []
Tests  1 failed | 97 skipped (98)
```

After `1aa923ef3` it passes, as do the other tests now read at the reviewed revision. The CLI notice's test arrived with the notice, so its failing run is the mutant that deletes the notice, which it kills.

## The property oracle

`review-records-export.test.ts` now checks the guarantee itself, over hosts with stores of their own that sync late: for every dismissal the reader keeps, the host that wrote it still holds it, and so does a host that holds it and then meets each round its writer did not hold. Seeds 9, 112 and 302 stay as named cases; seed 112 now reads live where its writer keeps the dismissal, the accepted cost. Over 20 seeds no outcome breaks the guarantee.

The oracle cannot kill mutants of the push rule's trigger test, since a line toggled twice restores the trigger; the multi-hunk tests in `recorded-round.test.ts` kill them instead.

## Mutants

[The run log](2026-11-20-issue-481-one-revision-rule-runs.json) holds every mutant the instrumenter makes on the reader's lines, 147 at `32a366064`: `contents`, `dismissalsOf`, `roundsSince`, `sightingsOf`, `byFinding`, `sharedDismissalHolds`, and the `findings --records` notice, changed or not. Each claim ran its named test alone, unmutated and then mutated.

- 144 killed. One of them, `pending.length >= 0`, never ends: its named test alone hung past 120 seconds, and passes unmutated in 3.
- 3 equivalent, each with its reason in the log.

A first run at `1aa923ef3` over 158 mutants left 19 survivors. `32a366064` added tests for the proof check by file and hash, a round of another changeset, a round since that follows an unknown round, a check record's citation, and a round whose records cannot stand under `findings --records`. It removed the two dead fallbacks.

`05008c159` rewrote the frontier walk's loop to satisfy Biome. [The inventory](2026-11-20-issue-481-one-revision-rule-mutants.json), from `melian mutants list d1685423b...HEAD` at that head, has 58 rows. 47 carry their claims from the run log, matched by line and by the source text at the mutant's columns. The 11 on the rewritten lines and two CLI lines outside the run log's range ran again at `05008c159`, and the loop mutant hung again. That makes 54 killed, 1 equivalent, and 3 ignored by configuration.
