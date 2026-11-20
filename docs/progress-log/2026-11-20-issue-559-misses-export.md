# Issue 559: the comparison exports its misses

Builder agent, 2026-11-20, the first of five pull requests for [issue #559](https://github.com/melian-agent/melian/issues/559), whose [plan](https://github.com/melian-agent/melian/issues/559#issuecomment-7034414009) the coordinator accepted.

`melian compare misses <range|#pr> [--out <path>]` writes each valid external finding no Melian finding matches as the misses file `MELIAN_EVAL_MISSES` reads. A miss a person ruled `out-of-scope` stays out. One with no lines at its compared head is named on standard error with why: no file or line, the base side, an outdated thread, or another commit. `Comparison.misses` decides which findings are misses, and `ComparisonExport.misses` names each case and keeps a finding compared in several rounds from the last.

A test in `packages/evals/test/comparison-misses.test.ts` loads the export through `Miss.load`, so a change to either shape fails it. No fix commit is recorded yet: the coordinator put it last, since it changes the stored adjudication, which [pull request #562](https://github.com/melian-agent/melian/pull/562) and [pull request #603](https://github.com/melian-agent/melian/pull/603) also change.

The change reads stored comparisons and writes a file a person names. It guards no trust and writes no stored shape, so it owes no hand mutation proof.
