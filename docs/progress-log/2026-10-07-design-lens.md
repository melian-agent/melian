# Build the design lens

The `design` lens is built, after the documentation pull request that recorded [the decision](../decisions/2026-10-07-design-lens.md). It is built in, in `packages/core/lenses/design/LENS.md`, on the heavy tier with `verify: true`, and carries the nine rules the decision names. Melian's root `melian.yaml` adds `lens.design` to its `full` tier. The default `full` tier does not, so a repository opts in.

The lens declares one level, `careful`, with `reads: functions`. The schema requires `careful` and makes `quick` and `deep` optional, so no cheaper variant was invented: a lens that reads hunks cannot see a key's omitted input three files away or a `files` list beside a changed read. Its budget is 8 findings, 300k tokens and 45 tool calls, above the other heavy lenses' `careful` budget of 200k and 30, because it reads decision files beside the code.

Four goldens ship, not the nine the decision names: `design-identity-missing-input`, `design-fail-open-default`, `design-unshipped-artifact`, and `design-clean`. [BACKLOG.md](../../packages/evals/goldens/BACKLOG.md) lists the five rules still owed one. Because the root tier now holds `lens.design`, the eight existing goldens with a `melian.golden.yaml` carry it, and the seven `durability` goldens script it to report nothing. A live run of three passes is owed.
