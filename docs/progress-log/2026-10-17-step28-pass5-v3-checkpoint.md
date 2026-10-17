# Step 28 pass 5: record version 3’s own checkpoint

[Pull request #142](https://github.com/melian-agent/melian/pull/142), review-of-record F3.

The version-3 publication generator wrote its checkpoint as a literal.
It now captures the running task from storage before the fake GitHub refuses the post, and writes `task.state.checkpoint`.
A terminal receipt has no checkpoint, so reading after failure would not record version 3’s state.

The generator ran against `8aca01e4`’s archived package sources, with workspace imports resolving to those sources.
The regenerated fixture keeps version 3’s checkpoint unchanged; its temporary repository’s commit hashes changed.
The literal equalled version 3’s initial state, so no behaviour test could fail for the old fixture.
Regeneration from the authority and the existing SQLite reopen test verify the correction.

Both publication crash and stage-telemetry reopen files passed, 30 tests.
The version-2 timing mutant now has proof too: preserving its checkpoint as version 3’s fails the no-invented-start assertion.
Production code was restored after that mutation. The implementation plan stays unchanged.
