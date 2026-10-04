# durability-clean-upsert

The clean counterpart of `durability-replayed-append`, from finding 9 of the [comparison record](../../comparisons/2026-10-03-pr-11.md) for [pull request #11](https://github.com/melian-agent/melian/pull/11). It applies the rule that finding produced: a tool with a durable side effect is an idempotent upsert keyed by a stable ID and marked replay-safe. `add_note` writes each note under its file and line, so a replay after a crash writes the same note again, and a review must report nothing.
