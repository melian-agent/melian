# Step 28 pass 5: keep verification when reopening cached findings

[Pull request #142](https://github.com/melian-agent/melian/pull/142), F1 follow-up from the builder’s final review.

The first fix reopened cached findings through a producer upsert.
That cleared their verification. A completed verifier was then reused without restoring its findings records.
A confirmed code finding fell to advisory, and the second A still passed.

The real lens, verifier, review and dismissal probe failed first on `d7f04380`: expected failure, received success.
A storage probe also failed: both producers’ verification records disappeared.
Cached reopening now changes lifecycle alone, through the same reopen transition as a fresh sighting.
It preserves verification, resets the proof, bumps all sighted revisions once, and stops after the first reopening sighting.
The regression keeps the code finding confirmed and blocking, with no new model call.

Validation: 122 focused tests passed. Twelve hand mutations failed, including restoring the upsert, clearing the proof,
removing the stop, losing another revision’s invalidation, and changing the shared transition’s legacy defaults.
The initial whole gate on `d7f04380` exited 1: 4,530 passed, 53 skipped and the four known sandbox process failures.
It had no timeout. The whole gate is rerun on this correction; the report records the result.
The implementation plan stays unchanged.
