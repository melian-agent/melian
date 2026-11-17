The hand mutation proof of [pull request #476](https://github.com/melian-agent/melian/pull/476), for [issue #425](https://github.com/melian-agent/melian/issues/425), stopped part-way by [the maintainer's ruling of 2026-11-16](https://github.com/melian-agent/melian/pull/476#issuecomment-6910669670).

The [inventory](2026-11-16-pr-476-mutants.json) comes from `melian mutants list` over the pull request's range, with `--claims-in` naming its nine files that guard trust or durability. Those files owe 1,169 mutants. Each mutant that ran was run against one named test alone, after that test passed unmutated. 533 ran at 7a044656, and 52 kills were carried from 91a77bdd by git's line map with the mutant's text unchanged.

| | Mutants |
| --- | --- |
| Killed by a named test | 526 |
| Ran, with no candidate test killing it | 59 |
| Not run | 584 |

Of the 59, 33 were examined. Six new tests kill some of them, each failing with its mutant applied: f0ecb2af, bbf027be, dede060c, 86439669, 1af789c8 and db05bf4e. Others are equivalent, and some mutate code a later commit removed; [the progress report](https://github.com/melian-agent/melian/pull/476#issuecomment-6907300625) gives each reason. The other 26 were not examined: 16 in `recorded-round.ts`, 9 in `findings.ts` and 1 in `summarize.ts`. Most were judged against probing-level tests that timed out unmutated under the load of three runners, so they are undecided rather than shown to survive.

The 584 not run are 283 in `review.ts`, 262 in `review-records.ts`, 30 in `recorded-round.ts` and 9 in `summarize.ts`. The inventory claims nothing for them, by the maintainer's ruling.
