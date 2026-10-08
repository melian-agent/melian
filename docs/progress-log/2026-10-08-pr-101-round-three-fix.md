# Pull request 101, round three fix

Melian's third round found that no test checked which providers the host unlock receives for a fresh lens task, so replacing `runsOf(input.lenses)` with `input.lenses` at `packages/pipeline/src/review.ts` line 1025 left every test green. The test "names the provider of the run a quick lens escalates to, beside its own" in `packages/pipeline/test/review.test.ts` triages a lens to quick on one provider, routes its escalation to another, and asserts the lens task's unlock names both. With the mutation applied the test fails; with it restored the test passes.
