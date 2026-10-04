# Live golden run 7, 2026-10-05

The first live runs of `durability`, Melian's repository lens under `.melian/lenses/durability/`, over its five goldens. It compares the lens as first written with the lens after one tuning round, each reviewed three times.

- Melian under test: the code of `b193fbc`, the last commit of [pull request #42](https://github.com/melian-agent/melian/pull/42), with this pull request's lens, goldens, and tests on top. The untuned passes ran at `8788f7e` and the tuned ones at `7a7c56b`, which the rebase onto `main` left unreachable. Their rebased commits on this pull request's branch, `b44cdaf` and `d444b8a`, hold byte-identical lenses, built-in and repository, root `melian.yaml`, and `durability-*` goldens: `git diff 8788f7e b44cdaf` and `git diff 7a7c56b d444b8a` over `.melian/`, `packages/core/lenses/`, `melian.yaml`, and `packages/evals/goldens/durability-*` print nothing. `main` had since changed only adjudication, the policy-change guardrail, and documents, none of which reaches the lens findings a golden scores. pi-ai 1.0.0 and Pi Durable 1.0.0.
- Lens versions: `durability` `5631752af610` untuned and `0accf06e74f3` tuned; `correctness` `c22842327fa3`, `contracts` `686d7ad61a40`, `trust-boundary` `593b84bf6e82`, `removed-behaviour` `45fa8885fd01`, `tests` `bee1be69be22`, and `conventions` `bb08d9e590e4` throughout.
- Corpus: the five `durability-*` goldens. Each runs Melian's own `full` tier, the six built-in lenses and `durability`, through its `melian.golden.yaml`, and carries the lens in its trees as `LENS.golden.md`.
- Model: `anthropic/claude-opus-5-5` for every tier, through the runner's model setting. Every lens runs at `careful`, on `heavy`.
- Credentials: an Anthropic OAuth token, loaded with `node --env-file` on the built packages.

## Method

The logging runner of [the sixth run](2026-10-04-live-goldens-6.md#method), limited to goldens whose names start with `durability-`, and reading the lens versions from the checkout, where the repository lens lives. It calls `runGolden` and `scoreGolden` from the built packages, as `live.ts` does, and records every finding with the lenses that sighted it. Each set of three passes ran one after another, after `npm run build`.

Scoring matches on file and rule. The golden scores count every lens's findings, since a golden scores the whole review. [The evals guideline](../../../docs/guidelines/evals.md#two-modes) sets the bars: over three passes, a lens's goldens need a worst precision of at least 0.8 and a worst recall of at least 0.6.

## Results, untuned

Per golden, over three passes:

| Golden | Expected | Reported | Precision worst | Precision mean | Recall worst | Recall mean |
| --- | --- | --- | --- | --- | --- | --- |
| `durability-attach-key` | 1 | 4, 5, 4 | 0.20 | 0.23 | 1.00 | 1.00 |
| `durability-clean-upsert` | 0 | 0, 1, 0 | 0.00 | 0.67 | 1.00 | 1.00 |
| `durability-replayed-append` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `durability-resumed-publish` | 1 | 3, 2, 2 | 0.33 | 0.44 | 1.00 | 1.00 |
| `durability-superseded-write` | 1 | 2, 2, 2 | 0.50 | 0.50 | 1.00 | 1.00 |

| Goldens | Precision per pass | Worst | Mean | Recall per pass | Worst | Mean |
| --- | --- | --- | --- | --- | --- | --- |
| `durability-*` | 0.40, 0.36, 0.44 | 0.36 | 0.40 | 1.00, 1.00, 1.00 | 1.00 | 1.00 |

By the lens that reported each finding, per pass:

| Lens | Reported | Matched | Extra |
| --- | --- | --- | --- |
| `durability` | 4, 6, 5 | 4, 4, 4 | 0, 2, 1 |
| `correctness` | 5, 4, 3 | 0, 0, 0 | 5, 4, 3 |
| `removed-behaviour` | 1, 1, 1 | 0, 0, 0 | 1, 1, 1 |
| `contracts`, `trust-boundary`, `tests`, `conventions` | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 |

`durability` found all four seeded defects in every pass, at the expected file and rule. Its own extras were two kinds. In passes 2 and 3 it reported `durability-attach-key`'s defect twice under `idempotency-key`: once for the inputs the key leaves out, and once, at the line that returns the stored task, for a failed run kept for good, which the golden declares as one more outcome of the same key. In pass 2 it reported `durability-clean-upsert`'s keyed note as `replay-duplicate`, because a second call for the same line replaces the first; the tool documents that, and a replay writes the same note again.

## The tuning round

One change to the lens, `d444b8a`: an upsert keyed by a stable ID is replay-safe even though a later call with the same key replaces the earlier value, and one defect is reported once, at its line, with each outcome named in its failure scenario. No golden changed.

## Results, tuned

Per golden, over three passes:

| Golden | Expected | Reported | Precision worst | Precision mean | Recall worst | Recall mean |
| --- | --- | --- | --- | --- | --- | --- |
| `durability-attach-key` | 1 | 4, 4, 4 | 0.25 | 0.25 | 1.00 | 1.00 |
| `durability-clean-upsert` | 0 | 0, 0, 0 | 1.00 | 1.00 | 1.00 | 1.00 |
| `durability-replayed-append` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `durability-resumed-publish` | 1 | 2, 2, 2 | 0.50 | 0.50 | 1.00 | 1.00 |
| `durability-superseded-write` | 1 | 2, 2, 2 | 0.50 | 0.50 | 1.00 | 1.00 |

| Goldens | Precision per pass | Worst | Mean | Recall per pass | Worst | Mean |
| --- | --- | --- | --- | --- | --- | --- |
| `durability-*` | 0.44, 0.44, 0.44 | 0.44 | 0.44 | 1.00, 1.00, 1.00 | 1.00 | 1.00 |

By the lens that reported each finding, per pass:

| Lens | Reported | Matched | Extra |
| --- | --- | --- | --- |
| `durability` | 4, 4, 4 | 4, 4, 4 | 0, 0, 0 |
| `correctness` | 4, 4, 4 | 0, 0, 0 | 4, 4, 4 |
| `removed-behaviour` | 1, 1, 1 | 0, 0, 0 | 1, 1, 1 |
| `contracts`, `trust-boundary`, `tests`, `conventions` | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 |

## What the runs show

`durability` itself is exact once tuned: twelve of twelve seeded defects found over three passes, no extra of its own, and nothing on the clean golden. The goldens still fall below the precision bar, and every extra restates a defect `durability` owns, at the same file and line, under another lens's rule:

- `correctness` reports the attach key in every pass as `wrong-result`, often with the failed run kept for good as a second finding, and the superseded walkthrough task as `state-ordering`. It never reports the replayed append, the one defect that needs Pi Durable's replay contract to see.
- On `durability-resumed-publish`, `correctness` reports the added loop in every pass, at line 58 or 60. In tuned passes 2 and 3 it names the seeded defect, resumed tasks posting for a revision the pull request has left. In the other four it names something else: that `resume()` may restart a task another live `publishReview` call is running, that two overlapping calls can both find no unfinished task and both create one, or that the wait sits between the head check and the new task. Melian's own `publish.ts` waits for leftover tasks the same way, so this record treats those as noise rather than undeclared defects.
- `removed-behaviour` reports the attach key in every pass, as `dropped-guard` or `dropped-error-path`: the base started a task on every call, so a failed run was retried, and the head's attachment removed that.

So the boundary leaks from the other side. `durability` hands defects that need no crash to `correctness`, but `correctness` and `removed-behaviour` name no hand-off to `durability`. A hand-off can be added without touching the built-in lenses: a repository lens such as `.melian/lenses/correctness/LENS.md` with `extends: correctness` and a `handoffs` entry for `durability`, since hand-offs layer through `extends`. It would not help most of Melian's own pull requests, though. A hand-off renders only when the neighbour's selected files include every file the handing lens reviews, and `durability` reviews only `packages/pipeline/src/` and `packages/github/src/`, while nearly every Melian pull request also changes documents. Either the hand-off rule would have to work per file, or `durability`'s paths would have to widen to every file the other lenses read. Both are decisions for the maintainer, and this pull request makes neither.

## The bars

Tuned, over three passes:

| Lens | Worst precision on its goldens | Worst recall on its goldens | Meets the bars |
| --- | --- | --- | --- |
| `durability` | 0.44 | 1.00 | No: precision |

`durability` ships below the precision bar, as `trust-boundary` did in the sixth run, and for the same reason: none of the extras on its goldens is its own. Untuned, its goldens stood at a worst of 0.36.

## Cost

Untuned, each pass made 150 to 154 requests in 185 to 213 seconds, about 39,000 output tokens, $1.95 to $2.08 at list price. Tuned, 143 to 152 requests in 174 to 185 seconds, about 39,000 output tokens, $1.95 to $1.98. An OAuth subscription is not billed per token.
