# Mutation proof hand-over for pull request 476

Builder agent: this directory holds the mutants of two files from [pull request #476](https://github.com/melian-agent/melian/pull/476) that two helper sessions run for its builder. This branch is scratch: it is never merged, and never pushed to the pull request's branch.

| Helper | File | Results file |
| --- | --- | --- |
| builder of issue #496 | `packages/pipeline/src/review-records.ts` | `tmp-mutants/results-review-records.jsonl` |
| builder of issue #460 | `packages/pipeline/src/review.ts` | `tmp-mutants/results-review.jsonl` |

## Files

- `inventory.json`: the two files' rows of the version-2 inventory from `melian mutants list origin/main...4c2941b6 --json --all` with `--claims-in` naming the pull request's nine trust and durability files. The runner takes only rows with `status: "generated"` in your one file.
- `proved-*.jsonl`: rows the builder has already run. The runner skips them.
- `run.mjs`: the runner.

## Running

The head is exactly 4c2941b6. Use a clean worktree of this branch, whose tree matches 4c2941b6 everywhere outside `tmp-mutants/`; the runner refuses any other tree, and any change under `packages/`.

```bash
git fetch origin scratch/pr-476-mutants
```

```bash
git worktree add ../melian-worktrees/m476-helper FETCH_HEAD
```

```bash
cd ../melian-worktrees/m476-helper && npm install -g npm@11.19.0 && npm ci
```

```bash
env -u MELIAN_STATE_DIR node tmp-mutants/run.mjs "$PWD" packages/pipeline/src/review-records.ts tmp-mutants/results-review-records.jsonl
```

For `review.ts`, pass `packages/pipeline/src/review.ts` and `tmp-mutants/results-review.jsonl`. Run one runner per worktree: two runners in one worktree test each other's mutants. The runner writes nothing but the results file and its own scratch directory, and resumes where it stopped, skipping every row already in the results file.

Commit only your results file and push it to `scratch/pr-476-mutants` after every 50 rows. A rejected push means the other helper pushed first: fetch, rebase your one commit onto it, since the two files never conflict, and push again.

## How a row is recorded

The runner applies one mutant, then:

1. Runs the candidate test files for the mutated file with `--bail=1`, then the whole `packages/pipeline` suite if no candidate failed.
2. For a failing test, it restores the source and runs that test alone, by its file and its anchored `ancestorTitles > title` pattern. If exactly one test is collected and it passes unmutated, it applies the mutant and runs that test alone again.
3. The mutant is killed only when that single test fails, or hangs, with the mutant applied. The row's `killer` names the test.

A row with no `killer` is a survivor. Its `rejected` list names the tests that failed in step 1 but that failed unmutated too, or passed alone with the mutant, so they kill nothing. A suite failure is never a kill.

After each row the runner checks that `packages/` is clean and exits with code 2 if it is not. Then restore with `git checkout -- packages` and look before you restart.

## Survivors

Report every survivor in your results file as the runner wrote it, and nothing more. Do not write a test for one. The builder writes those tests on the pull request's branch.

## Hangs

Each Vitest run has a 20-minute limit. When it passes, the runner records `timedOutIn` and moves on, but Vitest's worker processes can outlive the `npx` it stopped. After a timeout, list the processes whose command line names your worktree and that descend from the runner's pid, which you recorded when you started it. Stop each by that pid, SIGTERM and then SIGKILL, one level at a time with `pgrep -P <pid>`. Never signal a process group, a negative pid, or a process found by name alone.
