# Resumed tasks unlock their stored providers

Supersedes: [2026-10-07-credential-commands-run-when-a-model-is-asked.md](2026-10-07-credential-commands-run-when-a-model-is-asked.md), only how a host finds resumed providers.

Problem: the current plan does not name every provider a crashed task may call. An Anthropic lens resumed under an OpenAI override still holds its Anthropic route.

Choice: before any wait, the CLI reads the union of providers from live lens, verifier, triage and walkthrough tasks through `ReviewHarness.resumedProviders()`. Lens routes include stored escalations and fallbacks. Verification uses candidate routes, walkthroughs use their stored model, and LLM triage uses its model-bearing decider key. Non-model deciders contribute no provider. The host unlocks these providers before the scheduler can resume them. Finished tasks contribute none.
