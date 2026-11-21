# Issue 561: parity per total budget

[Issue #561](https://github.com/melian-agent/melian/issues/561).

## The measurement

`npm run eval:parity --workspace @melian-agent/evals` reviews each named miss twice, both with the whole review and every route held to its first model. The committed arm runs the base's policy and lenses as committed. The parity arm shares the committed arm's lens spend on the same miss, cache reads out and the verifier's and probers' spend taken off the top, among the tier's lenses by `total × (0.5/N + 0.5 × lines/Σlines)`. Every parity lens gets the design lens's capabilities: the graph tools and their paragraph, `high` thinking, its `deep` level with probing where core allows, a findings budget of at least 16, and 400 tool calls, so the token share binds. `docs/guidelines/evals.md` sets out the method, its settings and its stops, under "Measuring parity per total budget".

`packages/evals/src/parity.ts` holds the two arms and `measureParity`; `parity-live.ts` is the entry point. The run resumes by miss from its results file, refuses a file written at another commit, and refuses a checkout with uncommitted changes. It stops on a review or run token stop, a provider's usage limit, or a stage that answered on more than one model.

## Both arms open Enola's graph

Every earlier measurement left the design lens's graph tools refusing, because no measurement opened the graph. `reviewTarget` now opens Enola's graph of the head, as the CLI does, for a route that asks for it, and throws when the graph cannot be read, so neither arm runs without it.

## Each review keeps its store

A live review can now keep its store in a new SQLite file. The parity run keeps one per review and arm under `<results>.stores/`, by the coordinator's direction of 2026-11-18, so a miss one arm found and the other missed can be read turn by turn. The stores stay on the host. `reviewTarget` refuses a file that already exists, since it would resume a review rather than measure afresh.

## The provider-limit predicate

The pipeline exports `isProviderLimit`, which `isFailoverError` now calls, so the run's limit stop asks the same question failover does. The issue holds the measurement code to tests, without a hand mutation proof. The coordinator directed, on 2026-11-18, that the harness change alone owes one. Its six mutants were enumerated over `c6d20701...6526cf56` and each was run against its named test alone in `packages/pipeline/test/harness-failover.test.ts`. All six were killed; [the inventory](2026-11-18-issue-561-provider-limit-mutants.json) records each.

## The run record

`packages/evals/runs/parity-per-total-budget.template.md` is the record's skeleton. It carries the paragraph on the refusing graph tools, the token units, the Agent tool's figure, `high` thinking's share and the [pull request #552](https://github.com/melian-agent/melian/pull/552#issuecomment-6965864283) yardstick. The pilot fills it: three misses, [pull request #89](https://github.com/melian-agent/melian/pull/89)'s range among them, on subscription logins.
