# Step 14, an oversized analyser glob fails with its reason

The analyser's `excludes` in `packages/core/src/analyser.ts` now catches `Refused` and throws a `CheckError` `unreadable` that names the configuration file and the engine's reason. Before, a Biome `ignore` entry past the step limit escaped `evaluateGuardrails` as a bare `Refused`, an opaque failure. Item 5 of step 14 in the [implementation plan](../design-implementation-plan.md); the core guideline's policy-change-review section records it.
