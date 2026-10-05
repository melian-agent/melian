# Comparison adjudication, statistics, backlog, and export

Milestone 2 step 15 adds local comparison judgements with author identity, time, and replacement history. It keeps version 1 readable and leaves the review verdict untouched. Core's comparison objects compute recall, precision, misses, repeat clusters, golden debt, and the drain notice. The CLI reaches each operation and exports stored rounds as escaped markdown or JSON.

The [metrics decision](../decisions/2026-10-05-comparison-metrics.md) defines the arithmetic, date filters, and conservative local drain notice. The three skills carry one-line uses, and the Claude Code copy matches its source. Core, pipeline, and scripted CLI tests cover the objects and commands. A fixed markdown snapshot pins export.

The branch is `compare-adjudicate`, based on `compare-import`. The draft pull request number is pending: this session cannot write the worktree's git index or reach GitHub. Rename this entry to include that number when the draft opens, and put its link in step 15.

Validation: the full gate stops at the release-age check because the sandbox cannot reach the npm registry. Biome, dependency pinning, and type checking pass separately. The final complete suite passes 1,052 tests and times out in two unchanged tests; both pass alone. An earlier complete run passes all 1,049 tests before five regression tests are added, and the final comparison suite passes all 50. Every failure in the intervening loaded run also passes alone. No dependency changed.

Learning: this worktree's git index lives in the common repository outside its writable root. A file edit can succeed while `git add` fails creating `index.lock`. Use a session authorised to write that common directory for commits; do not gate tests under inherited `GIT_*` variables.

Learning: Vitest 5 can consume the first file argument after `-u`, leaving that test outside the run. Put explicit file paths before `--update`, and confirm the reported file count before accepting a snapshot update.
