# Live golden run 8, 2026-10-05

The first live runs with Melian's `correctness` and `removed-behaviour` handing `durability` the defects that need a crash, a restart, a replay, a resumed or superseded task, or a record an earlier run stored. Three passes over the five `durability` goldens, set beside [run 7](2026-10-05-live-goldens-7.md#results-corrected), the lens as it shipped. Then one pass over the `correctness` and `removed-behaviour` goldens with the hand-off rendered over every file.

This run measured the overrides, not per-file hand-offs. Every changed file in the five goldens lies under `durability`'s paths, so every request took the every-file form, which renders as hand-offs did before this change. [Run 9](2026-10-05-live-goldens-9.md) adds goldens that render the listed form.

- Melian under test: `5116c9b`, built with `npm run build`, on Node 24.18.0. pi-ai 1.0.0 and Pi Durable 1.0.0. The next commit on the branch, `84dac74`, changes a comment only; the commits after it change the lenses and goldens, which run 9 measures.
- Lens versions: `durability` `1e23dea9f30d`, unchanged from run 7 and not tuned. `correctness` `4b100d521191` and `removed-behaviour` `d9d8851b1ced`, the built-ins extended by Melian's overrides with only a `handoffs` entry for `durability`; run 7 ran the built-ins alone, `c22842327fa3` and `45fa8885fd01`. `contracts` `686d7ad61a40`, `trust-boundary` `593b84bf6e82`, `tests` `bee1be69be22`, and `conventions` `bb08d9e590e4`, as in run 7.
- Corpus: the five `durability-*` goldens, each running Melian's own `full` tier through its `melian.golden.yaml` and carrying `durability` and the two overrides in its trees as `LENS.golden.md`.
- Model: `anthropic/claude-opus-5-5` for every tier, through the runner's model setting. Every lens runs at `careful`, on `heavy`.
- Credentials: an Anthropic OAuth token, loaded with `node --env-file` on the built packages.

## Method

The logging runner of [the seventh run](2026-10-05-live-goldens-7.md#method), reading lens versions through `Lens.load`, which replaced `loadLenses` in [pull request #51](https://github.com/melian-agent/melian/pull/51), and recording the "Neighbouring lenses" section of each lens request's system prompt. The three passes ran one after another. Scoring and the bars are as in run 7: over three passes, a lens's goldens need a worst precision of at least 0.8 and a worst recall of at least 0.6.

Every one of the 153 `correctness` and `removed-behaviour` requests over the three passes carried the hand-off to `durability` in its short form, with no list, because every changed file in these goldens lies under `durability`'s paths.

## Results

Per golden, over three passes:

| Golden | Expected | Reported | Precision worst | Precision mean | Recall worst | Recall mean |
| --- | --- | --- | --- | --- | --- | --- |
| `durability-attach-key` | 1 | 4, 5, 5 | 0.20 | 0.22 | 1.00 | 1.00 |
| `durability-clean-upsert` | 0 | 0, 0, 0 | 1.00 | 1.00 | 1.00 | 1.00 |
| `durability-replayed-append` | 1 | 1, 1, 1 | 1.00 | 1.00 | 1.00 | 1.00 |
| `durability-resumed-publish` | 1 | 2, 1, 1 | 0.50 | 0.83 | 1.00 | 1.00 |
| `durability-superseded-write` | 1 | 1, 2, 2 | 0.50 | 0.67 | 1.00 | 1.00 |

| Goldens | Precision per pass | Worst | Mean | Recall per pass | Worst | Mean |
| --- | --- | --- | --- | --- | --- | --- |
| `durability-*` | 0.50, 0.44, 0.44 | 0.44 | 0.46 | 1.00, 1.00, 1.00 | 1.00 | 1.00 |

By the lens that reported each finding, per pass:

| Lens | Reported | Matched | Extra |
| --- | --- | --- | --- |
| `durability` | 5, 5, 5 | 4, 4, 4 | 1, 1, 1 |
| `correctness` | 1, 2, 2 | 0, 0, 0 | 1, 2, 2 |
| `removed-behaviour` | 1, 1, 1 | 0, 0, 0 | 1, 1, 1 |
| `trust-boundary` | 1, 1, 1 | 0, 0, 0 | 1, 1, 1 |
| `contracts`, `tests`, `conventions` | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 |

Against run 7's corrected passes. The comparison is not controlled: [pull request #51](https://github.com/melian-agent/melian/pull/51), which moved lenses onto objects, landed between the runs, and `durability-clean-upsert`'s tool comment was narrowed after run 7, which removed the extra run 7 drew there.

| | Run 7, corrected | Run 8 |
| --- | --- | --- |
| Worst precision | 0.31 | 0.44 |
| Mean precision | 0.33 | 0.46 |
| Worst recall | 1.00 | 1.00 |
| Findings reported over three passes | 36 | 26 |
| Extras over three passes | 24 | 14 |
| Extras from `correctness` | 11 | 5 |
| Extras from `removed-behaviour` | 7 | 3 |
| Extras from `trust-boundary` | 2 | 3 |
| Extras from `durability` | 4 | 3 |

## Extras by lens

`durability` found all four seeded defects in every pass, at the expected file and rule. Of the 14 extras, 11 are other lenses', all on two goldens:

- `correctness`, 5: `durability-attach-key` in every pass as `wrong-result`, for the inputs the key leaves out; and `durability-superseded-write` in passes 2 and 3 as `state-ordering`, for an older walkthrough task overwriting a newer one's text. Both restate a defect `durability` owns. It no longer reported `durability-resumed-publish`, which it did in two of run 7's three passes, and no longer reported the attach key's failed run kept for good as a second finding.
- `removed-behaviour`, 3: `durability-attach-key` in every pass, as `moved-code-lost-anchor` once and `dropped-guard` twice: the base created a task on every call, and the head reuses the one stored under its key. It no longer reported `durability-resumed-publish`, which it did in every pass of run 7.
- `trust-boundary`, 3: `durability-attach-key` in passes 2 and 3 as `head-controls-judge`, because the key leaves out the configuration that names the checks, and `durability-resumed-publish` in pass 1 as `fail-open`, a resumed task posting a verdict for a head the pull request has left. `trust-boundary` names no hand-off to `durability`.

The `correctness` and `removed-behaviour` leaks that remain sit where the two sides' hand-offs meet; `trust-boundary`'s do not, since it names no hand-off to `durability`. The attach key goes wrong on a second call that needs no crash, only a record the first call stored, and `correctness` and `removed-behaviour` read that call as an ordinary logic error rather than as a record an earlier run stored. The superseded walkthrough is two live tasks for one revision, which `durability`'s own hand-off to `correctness` names as "a race between live callers". Both are boundary wording, not the per-file rule: every request carried the hand-off.

The other 3 are `durability`'s own, one per pass on `durability-attach-key`: a second finding for the key's defect, at line 48 or 51, for a failed or aborted run kept for good, which the golden declares as one more outcome of the same key. Run 7 recorded the same three, and they stay recorded as its misses for the next tuning round. Run 7's fourth, on `durability-clean-upsert`, did not recur; that golden's tool comment was narrowed after run 7.

## The bars

| Lens | Worst precision on its goldens | Worst recall on its goldens | Meets the bars |
| --- | --- | --- | --- |
| `durability` | 0.44 | 1.00 | No: precision |

`durability` still ships below the precision bar of 0.8. Beside run 7, its goldens rose from a worst of 0.31 to 0.44, and the other lenses' extras fell from 20 to 11. Extras fell by 4 on `durability-attach-key`, by 4 on `durability-resumed-publish`, and by 1 each on `durability-superseded-write` and `durability-clean-upsert`. The next round has two jobs: say on both sides of the boundary who owns a key that attaches a later call to an earlier run's record, and who owns two live tasks racing for one record; and hold `durability` to one finding for the attach key.

## The overridden lenses' own goldens

As committed, the `correctness-*` and `removed-behaviour-*` goldens never render the hand-off: their tier has no `durability`, and their files lie outside its paths. One uncommitted pass added Melian's three repository lenses and root `full` tier to their trees, with `durability`'s paths widened to every file, so every `correctness` and `removed-behaviour` request carried the short form of the hand-off. It showed only that the short form cost no recall on those eight goldens, which hold no defect `durability` owns, in one pass.

The one expected finding missed, `correctness`'s on `correctness-deleted-guard`, was not the hand-off's: three passes of the golden as committed, with the built-in `correctness` alone, missed it the same way. [Pull request #57](https://github.com/melian-agent/melian/pull/57) traces it to the built-in hand-off to `removed-behaviour`, which gave away every deleted throw, and [run 9](2026-10-05-live-goldens-9.md) measures the fix.

## Cost

The `durability` passes made 154, 142, and 148 requests in 193, 143, and 251 seconds, 38,000 to 42,000 output tokens, $2.11, $2.03, and $2.13 at list price. The widened pass over the eight goldens made 152 requests in 184 seconds, 38,000 output tokens, $2.07. The six reruns of `correctness-deleted-guard` made 19 to 21 requests each, about 4,300 output tokens, $0.21 to $0.24. An OAuth subscription is not billed per token.
