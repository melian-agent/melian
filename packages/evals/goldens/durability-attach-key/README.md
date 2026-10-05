# durability-attach-key

Seeded from finding A8 of the [comparison record](../../comparisons/2026-10-03-pr-18.md) for [pull request #18](https://github.com/melian-agent/melian/pull/18): "asking twice runs once" was keyed on head and tier, so a changed base, configuration, or source returned stale results, and a transient failure was cached for good. The head adds that key to a `runChecks` that used to start a task on every call.
