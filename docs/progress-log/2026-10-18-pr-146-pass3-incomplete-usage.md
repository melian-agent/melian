# Incomplete triage usage after crash replay

[Pull request #146](https://github.com/melian-agent/melian/pull/146), pass 3, addresses Codex's high finding at decisions.ts:101–118. Before each provider request, the task commits its started count. Its result commit compares started with the number of measured responses and stores the difference as unmeasured. A lost receipt marks the stage and run total `usage incomplete: N request(s) not measured`, without estimating tokens.

The revised crash test failed on b6b3b3d9: expected usageIncomplete 1, received undefined. The same test passes with the fix, as do tests for post-settlement replay, receipt persistence before dispatch, receipt failures, missing responses and summed incomplete counts. Logs and the mutation inventory are under tmp/token-telemetry-pass3-* and tmp/token-telemetry-mutation-inventory.jsonl. All 34 final hand mutations failed their tests. The final whole gate passed lint, types, dependency checks and 4,602 tests; four ps-dependent tests failed and 53 tests skipped under the sandbox. The report lists each failure and the three ps-dependent skips. No test was weakened. The coordinator must run the host gate and static.mutation.

The new decision restates the earlier timing and usage clauses. It documents the Pi Durable 1.1.0 limit: GenerationTask and CompactionTask keep logical attempt checkpoints, with no durable resend count. UsageDoc contains settled responses. Lenses, verifier candidates and walkthroughs cannot identify every pre-settlement loss from those APIs.

This fix pass leaves the implementation plan and comparison record alone. The coordinator owns host mutation checks and model-based reviews. No live model calls ran.
