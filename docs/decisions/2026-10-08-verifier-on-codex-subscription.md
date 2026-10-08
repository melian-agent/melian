# Verification through the ChatGPT subscription

Supersedes: [2026-10-07-committed-routes.md](2026-10-07-committed-routes.md), its verifier acceptance list and cross-family requirement only. The preference for another family in [2026-10-04-verification-pass.md](2026-10-04-verification-pass.md) remains within the selected route.

Problem: Melian's verifier policy accepted Claude and an OpenAI API model, but no Codex subscription model. A maintainer with a ChatGPT subscription needed another provider's credential to satisfy policy.

Example: the design-golden live rerun needs a separately routed judge. The finder can use the subscription through `openai-codex`, while an OpenAI API verifier requires an API key the maintainer does not hold.

Choice: accept `openai-codex/gpt-5.6-terra` for the verifier. Keep `anthropic/claude-sonnet-5-5` as the committed default and keep its Claude fallbacks. Resolve and unlock the verifier's own provider, using its subscription credential without an OpenAI API key. A same-family route policy accepts is a plan notice saying "by the maintainer's choice", not a departure. An unaccepted same-family route still warns and records its departure.

The plan still tries another family first within the chosen route. A preference that must use Terra alone sets `fallbacks: []`, because changing a model inherits the committed fallbacks. Live lens goldens take the separate route through `MELIAN_EVAL_VERIFIER_MODEL`, as the finder takes `MELIAN_EVAL_MODEL`.

What this gives up: finder and verifier within one family can share blind spots. Acceptance records the maintainer's choice; it does not make those judgements independent. Sonnet remains the default for that reason.
