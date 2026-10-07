# CLI argument mutation inventory

For [pull request #68](https://github.com/melian-agent/melian/pull/68), tested 13 operators in main. Twelve failed existing CLI assertions. Inverting the diagnostic's Error discriminator passed them. Seventeen direct command tests pin source defaults, repeated sources, hand actions, ID and arity checks, and exact visible diagnostics for Error objects and strings. All 13 operators fail those tests; all 17 restored tests pass. No design decision changed.
