# Escalation keeps the lens version in route judgement

The broader targeted run for [pull request #221](https://github.com/melian-agent/melian/pull/221) found one remaining exact assertion from the lens identity fix. It expected only scope, level and model in the plan's completed-run map. The map now also carries the lens version.

The escalation test failed with the extra version field, then passed with the field added to its expected value. Its outcome and model assertions stay unchanged. This assertion-only commit adds no production mutants. The whole gate remains the host's job for this fix pass.
