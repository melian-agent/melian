# A resumed publisher requires the current decided round

This adds a task-side check to [publication round binding](2026-10-18-publication-round-binding.md).
The maintainer requested it for finding 410e116da7f2a237 on [pull request #152](https://github.com/melian-agent/melian/pull/152).

A passing review can leave a publish task pending after a crash.
A review-only harness can then decide blocking r2 without changing the publisher target.
On reopening PublishHarness, the target check alone still accepts r1 and publishes its saved passing verdict.

Before starting a provider session or making an external effect, the publish task reads melian.rounds.
Its bound round must equal the revision’s current round and have a saved verdict.
Otherwise the task ends superseded, names the current round in its reason, and posts nothing.
This applies to legacy and minted targets, including when a newer round remains undecided.

The task reads the accepted round’s saved verdict.
It does not fall back to the live verdict.
The target-validation transaction still captures and checks round identity before recording the publisher target.
The legacy migration and publication provenance rules remain as recorded in the binding decision.
No stored shape or task result changes.
