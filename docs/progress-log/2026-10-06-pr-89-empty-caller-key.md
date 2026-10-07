# Empty caller compatibility

The final gate for [pull request #89](https://github.com/melian-agent/melian/pull/89) found five exact triage-key assertions. An empty caller section now leaves the existing key unchanged, avoiding needless reruns of old tasks that saw no callers. Non-empty sections still hash into selection. No assertion was weakened.
