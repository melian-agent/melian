# Scripted triage reaches its branches

The seventeenth Melian round on [pull request #62](https://github.com/melian-agent/melian/pull/62) confirmed that the scripted triage test returned at the empty-plan guard.

The fixture now plans one correctness lens. Its Anthropic credential command writes a marker; the separate OpenAI triage command writes another. Scripted triage unlocks the lens command alone, returns no decider or skip reason, and never calls the fallback factory. No model request runs.
