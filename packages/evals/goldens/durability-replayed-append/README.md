# durability-replayed-append

Seeded from finding 9 of the [comparison record](../../comparisons/2026-10-03-pr-11.md) for [pull request #11](https://github.com/melian-agent/melian/pull/11): a crash between a finding's document commit and its tool result stored the finding twice. Recast on a new summariser tool: `add_note` is marked replay-safe but appends to a list, so the replay after such a crash appends the note again. `durability-clean-upsert` is its clean counterpart.
