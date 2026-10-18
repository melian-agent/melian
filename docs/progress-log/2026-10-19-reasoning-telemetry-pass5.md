# Reasoning telemetry: receipt usage assertions

[Pull request #153](https://github.com/melian-agent/melian/pull/153), pass 5, addresses finding 8093fea72bdf62d2.

Generation, compaction and review-stage tests now compare each receipt’s full usage with its own fake reply.
The fake boundary records usage beside the received body and model after Pi estimates streaming usage.
Distinct non-zero totalTokens expose zeroed receipts and receipts copied from another request, including failed failover replies.

The requested mutation replaces ConversationUsageRecorder.include’s receipt usage with `{ ...reply.usage, totalTokens: 0 }`.
All 58 original tests pass with that mutation, reproducing the test gap.
The tightened assertions fail in nine cases: three generation rows, two compaction rows, lens, verifier, walkthrough and failover.
The source mutation was restored. No production code or decision changed.
The implementation plan stays unchanged under the fix-pass rule.

The inventory is appended to tmp/reasoning-telemetry-mutations.json and copied to /Users/tal/dev/Melian/tmp/m2/scratch-reasoning/.
The report and proof logs live in that scratch directory; reasoning-telemetry-pass5-report.md records the gate and delivery results.

All 58 tests in reasoning-telemetry.test.ts pass with source restored.
The whole gate exits 1: 4,937 tests pass, 53 skip and four fail under the existing sandbox restrictions.
Three fail with `ps failed: undefined`: the real-process pid test and both real mutation backend tests.
The supervisor termination test receives toolFailed instead of invalidOutput under the same restriction as the previous pass.
Formatting, type checking, dependency checks and the audit threshold pass. No timeout or new failure occurred.
The coordinator must rerun the whole gate on the host.
