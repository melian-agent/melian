# Live golden run 10, 2026-10-05

The measurement for the first backlog drain, [pull request #71](https://github.com/melian-agent/melian/pull/71), which ships two owed goldens: `correctness-deleted-rethrow`, from A1 and E3 of [#42's record](../comparisons/2026-10-05-pr-42.md), and `conventions-free-constructor`, from D5 of [#51's record](../comparisons/2026-10-05-pr-51.md). Three passes over every `correctness-*` golden and three over every `conventions-*` golden, as [the drain rule](../../../docs/guidelines/evals.md#the-drain-rule) asks. No lens was tuned.

- Melian under test: `7c159a4`, built with `npm run build`, on Node 24.18.0. pi-ai 1.0.0 and Pi Durable 1.0.0. The `correctness-*` passes ran at `639668c`. `git diff 639668c 7c159a4` over `.melian/`, `packages/core/lenses/`, `melian.yaml`, and `packages/evals/goldens/` touches only `conventions-free-constructor/head/test/store.test.ts`, so the `correctness-*` trees are byte-identical at both. The `conventions-*` passes in the tables ran at `7c159a4`; [Three rounds before the last](#three-rounds-before-the-last) says why three earlier rounds ran at `639668c`, `f1c8039`, and `525c41c`. The commits after `7c159a4` add this record, the progress log, and the plan, and touch no lens or golden tree.
- Lens versions, as built in, since no golden here carries a repository lens: `correctness` `05037e7ba4a2`, `removed-behaviour` `45fa8885fd01`, `contracts` `686d7ad61a40`, `trust-boundary` `593b84bf6e82`, `tests` `bee1be69be22`, and `conventions` `bb08d9e590e4`, the versions [run 9](2026-10-05-live-goldens-9.md) ran.
- Corpus: the three `correctness-*` goldens and the eight `conventions-*` goldens. `correctness-deleted-rethrow` reviews under the `standard` tier, so only `correctness` runs on it; every other golden reviews under the default `full` tier.
- Model: `anthropic/claude-opus-5-5` for every tier. Every lens runs at `careful`, on `heavy`.
- Credentials: an Anthropic OAuth token, loaded with `node --env-file` on the built packages.

## Method

The logging runner of [run 9](2026-10-05-live-goldens-9.md#method), without its arms that add or remove Melian's repository lenses, filtered to the goldens whose names start with `correctness-` or with `conventions-`. Scoring matches on file and rule, and on the reporting lens where an expectation names a `source`, as `scoreGolden` does. In the per-lens tables a finding several lenses report counts once for each.

Every request on `correctness-deleted-rethrow`, three per pass, was `correctness`'s, and none rendered a "Neighbouring lenses" section: the `standard` tier ran `correctness` alone, with no hand-off to `removed-behaviour`.

## Results

### `correctness`

Per golden, over three passes:

| Golden | Expected | Reported | Precision worst | Precision mean | Recall worst | Recall mean |
| --- | --- | --- | --- | --- | --- | --- |
| `correctness-deleted-guard` | 2 | 2, 2, 2 | 1.00 | 1.00 | 1.00 | 1.00 |
| `correctness-deleted-rethrow` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `correctness-null-deref` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |

| Goldens | Precision per pass | Worst | Mean | Recall per pass | Worst | Mean |
| --- | --- | --- | --- | --- | --- | --- |
| `correctness-*` | 1.00, 1.00, 1.00 | 1.00 | 1.00 | 1.00, 1.00, 1.00 | 1.00 | 1.00 |

By the lens that reported each finding, per pass:

| Lens | Reported | Matched | Extra |
| --- | --- | --- | --- |
| `correctness` | 3, 3, 3 | 3, 3, 3 | 0, 0, 0 |
| `removed-behaviour` | 1, 1, 1 | 1, 1, 1 | 0, 0, 0 |

`correctness` reported the deleted rethrow as `unhandled-error` in every pass, at line 15 of `src/migrate.ts`, `introduced`, `P1`, naming the failed migration that `markApplied` records and the count that goes on rising. On `correctness-deleted-guard` it reported `wrong-result` beside `removed-behaviour`'s `dropped-guard` in every pass, as in run 9.

### `conventions`

Per golden, over three passes:

| Golden | Expected | Reported | Precision worst | Precision mean | Recall worst | Recall mean |
| --- | --- | --- | --- | --- | --- | --- |
| `conventions-bare-reference` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `conventions-clean` | 0 | 0, 0, 0 | 1.00 | 1.00 | 1.00 | 1.00 |
| `conventions-free-constructor` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `conventions-free-domain-function` | 1 | 2, 3, 3 | 0.33 | 0.39 | 1.00 | 1.00 |
| `conventions-injection` | 2 | 2, 2, 2 | 1.00 | 1.00 | 1.00 | 1.00 |
| `conventions-missing-doc-update` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `conventions-tsdoc-internal` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `conventions-unpinned-action` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |

| Goldens | Precision per pass | Worst | Mean | Recall per pass | Worst | Mean |
| --- | --- | --- | --- | --- | --- | --- |
| `conventions-*` | 0.89, 0.80, 0.80 | 0.80 | 0.83 | 1.00, 1.00, 1.00 | 1.00 | 1.00 |

By the lens that reported each finding, per pass:

| Lens | Reported | Matched | Extra |
| --- | --- | --- | --- |
| `conventions` | 8, 8, 8 | 8, 8, 8 | 0, 0, 0 |
| `correctness` | 2, 2, 2 | 1, 1, 1 | 1, 1, 1 |
| `trust-boundary` | 1, 2, 2 | 1, 1, 1 | 0, 1, 1 |
| `contracts` | 1, 1, 1 | 1, 1, 1 | 0, 0, 0 |
| `removed-behaviour` | 1, 1, 1 | 1, 1, 1 | 0, 0, 0 |
| `tests` | 1, 1, 1 | 1, 1, 1 | 0, 0, 0 |

The matched counts for every lens but `conventions` are the injection attempt on `conventions-injection`, which each reported beside `conventions`.

`conventions` reported `invoiceOf` as `quoted-rule-violation` in every pass, `introduced`, quoting the fixture's rule, and no other lens reported anything on `conventions-free-constructor`.

## Extras by lens

All 5 extras sit on `conventions-free-domain-function`, an older golden, and none is `conventions`'s:

- `correctness`, 3: `wrong-result` at line 8 of `src/comment.ts` in every pass, for a link that names the `main` branch rather than the pull request's revision.
- `trust-boundary`, 2: `injection-sink` at the same line in passes 2 and 3, for a file path and rule written into comment markdown and a URL unescaped.

The golden declares neither, and this record does not judge them. `correctness` drew the same finding in every pass of the three earlier rounds, and `trust-boundary` in some, so the golden may hold real defects it never declared. If it does, the guideline asks for them declared, in a pull request of their own.

## Three rounds before the last

The first three rounds of `conventions-*` passes each found a real defect in `conventions-free-constructor`'s head that the golden did not declare. Each was in the test the change adds, and `tests` reported it. [The evals guideline](../../../docs/guidelines/evals.md#a-golden) asks for trees written as working code apart from the declared defects, so each round fixed the fixture's test rather than declare a `tests` defect in a `conventions` golden:

| Round | Commit | `tests` reported | Fix | `conventions-*` worst precision |
| --- | --- | --- | --- | --- |
| 1 | `639668c` | `untested-behaviour` in every pass: no test reads back a paid invoice | `f1c8039` reads one back | 0.73 |
| 2 | `f1c8039` | `untested-behaviour` in every pass: the unpaid test compares only IDs | `525c41c` compares whole invoices | 0.67 |
| 3 | `525c41c` | `vacuous-test` in passes 1 and 3: the invoices are saved in ID order, so the test cannot tell save order from ID order | `7c159a4` saves them out of ID order | 0.67 |

`conventions` found the seeded breach in all nine of those passes. The other extras in those rounds were on older goldens: those above on `conventions-free-domain-function`, and `removed-behaviour`'s `dropped-guard` on `conventions-missing-doc-update` in pass 2 of round 2 and passes 1 and 2 of round 3, for the deleted `Math.round` that the golden's documented rounding rule depends on. Round 4 drew it in no pass.

## The bars

| Lens | Worst precision on its goldens | Worst recall on its goldens | Meets the bars |
| --- | --- | --- | --- |
| `correctness` | 1.00 | 1.00 | Yes |
| `conventions` | 0.80 | 1.00 | Yes, precision at the bar |

`conventions` meets the precision bar of 0.8 with nothing to spare, and every extra on its goldens is another lens's on `conventions-free-domain-function`. In the earlier rounds, the fixture's own test defects and `removed-behaviour`'s extra on `conventions-missing-doc-update` took the worst to 0.67. One such extra in a pass that counts would put it below the bar.

## Cost

The `correctness-*` passes made 40, 38, and 38 requests in 60, 54, and 48 seconds, about 8,800 output tokens, $0.45, $0.44, and $0.45 at list price. The `conventions-*` passes in the tables made 125, 123, and 121 requests in 129, 127, and 130 seconds, about 30,700 output tokens, $1.74, $1.75, and $1.73. The three earlier rounds cost $1.75 to $1.86 a pass. All fifteen passes came to $22.63 at list price. An OAuth subscription is not billed per token.
