# Publication thread-state design

[Pull request #145](https://github.com/melian-agent/melian/pull/145), for [issue #132](https://github.com/melian-agent/melian/issues/132).

Merged main at `748dfe37`, preserving step 28's publication and findings changes.
The class of defects is stored reply state disagreeing with the provider or with a later plan's ownership of a thread.
[The decision](../decisions/2026-10-18-owed-thread-returns.md) specifies a provider snapshot before planning, failure before writes, and current-plan authority over resolutions.
It keeps dismissal publication, status mapping and attestations intact.
Implementation waits for an attacking review.

The same-ID reopened-dismissal regression passes on the merged head because its guard already exists.
Removing `entry.dismissal === undefined` makes it fail: it finds one original thread where two are required.
Restoring the guard makes it pass.
The earlier test changed the snippet and therefore the ID, so it could not prove that guard.

The SQLite reproduction kills a publisher after its third review is recorded and before its first addressed edit.
A review-only harness then retries a failed lens at the same head and reports the original finding ID.
Publication reuses its original thread, then resolves it with the older instruction.
The test fails on the merged production code: `expected [ 1002 ] to not include 1002`.
It remains failing for the implementation phase; this change adds no production fix.
The existing test for a provider-accepted reply lost from storage stays unchanged.

Both publication files ran: 26 tests passed and only the new stale-resolution test failed.
Type checking passed.
The full gate also failed on four existing mutation-runner tests that require `ps`, which the Codex sandbox denies.
The coordinator still needs a host gate, alongside the intended red reproduction, before the implementation phase.
