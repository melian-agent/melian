# Issue 561: a failed review's spend counts

Codex's adversarial review of [pull request #582](https://github.com/melian-agent/melian/pull/582) at 727d58bc found that a parity review which threw recorded no tokens and no stages, though its `GoldenRunError` carried the telemetry of every stage that ran. The run's total then undercounted, and a usage limit a stage met did not stop the run.

The parity run now measures a failed review's stages from that telemetry and reads the stop cause from it. A test in `packages/evals/test/parity.test.ts` throws a `GoldenRunError` holding one lens stage of 100 tokens; before the fix the review recorded 0 tokens, and after it 100, with 40 cache reads. A second case, a stage that met a usage limit, now stops the run.
