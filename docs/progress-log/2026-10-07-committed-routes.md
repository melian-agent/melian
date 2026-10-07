# Committed routes moved to Codex

The root `melian.yaml` now routes `heavy` to Codex's Sol, `medium` to Terra, and `verifier` to Sonnet 5.5, each with accepted Claude and GPT stand-ins. `docs/design.md`, the step 10 line of the plan, and a [decision](../decisions/2026-10-07-committed-routes.md) record it. No test pinned the old values, since tests build their own configurations. `melian doctor` resolves `heavy` and `medium` on Codex and derives the verifier from Bedrock Sonnet where Anthropic credentials are absent.
