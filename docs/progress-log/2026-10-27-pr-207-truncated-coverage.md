# 2026-10-27: retain coverage for truncated lens results

The [fix-pass brief](https://github.com/melian-agent/melian/issues/204#issuecomment-6432521778) for [pull request #207](https://github.com/melian-agent/melian/pull/207) reports contracts finding `c7b77623f9944bd2` at `cf24bd8811f40e15c22c32e5f9df711728670347`.

The shared `text` constructor put its truncation note before the opening trust boundary. `ReviewTranscript.from` therefore skipped the whole result. A read of two 25 KiB lines delivered line 1 but recorded no coverage. Both search forms lost their 154 delivered matches when the rows exceeded 48 KiB.

The fix appends the note after the rendered result, including its closing boundary and continuation notes. The coverage parser and output bounds stay unchanged. The pipeline guideline records why the note must follow the result. Existing assertions now require the trailing note where a body was cut, including the long-file continuation check.

The three new regressions run real lens tools through the fake model and inspect the messages the model received. They assert the exact delivered coverage and full output, including omitted-line counts and notes outside the boundary. Each result stays within its tool's byte and line limits.

Before the fix, `npx vitest --run packages/pipeline/test/graph-tools.test.ts -t 'records coverage for delivered lines in truncated'` failed all three cases at the coverage assertion: `expected [] to deeply equal` the delivered read or search lines. After the fix, the whole file passed all 41 tests. Type checking and targeted Biome checks passed.

The requested package run, `env -u MELIAN_STATE_DIR npx vitest --run packages/pipeline --maxWorkers=2`, completed all 80 files: 2,059 tests passed, five failed and three skipped. One failure was the old long-file assertion that required the continuation note to come last. Its corrected targeted rerun passed.

The other four failures reproduced in isolated reruns of unchanged tests. Two in `mutation-real.test.ts` and one in `mutation-process-real.test.ts` throw `ps failed: undefined`. The supervisor case in `mutation-static.test.ts` receives `toolFailed` instead of `invalidOutput`; its shell must inspect its parent with `ps` before signalling that one parent. A direct `/bin/ps -o command= -p "$PPID"` exits 127 with `operation not permitted`. This sandbox cannot run those process checks. No process-control code or tests changed.

The final run, `env -u MELIAN_STATE_DIR npx vitest --run packages/pipeline/test/graph-tools.test.ts packages/pipeline/test/review.test.ts --maxWorkers=2`, passed both changed test files: all 202 tests passed.

The complete start-head inventory contains six mutants, with none omitted. The scratch runner applied each mutant alone and ran `graph-tools.test.ts` with the new truncated-read regression selected. All six failed that named test, including the two configuration-ignored string mutants. None survived. The [committed inventory](2026-10-27-pr-207-truncated-coverage-mutants.json) preserves every identity field, classification, command, exit status and failure. Enumeration at the final committed head matches the proved inventory.

Enumeration uses `node scripts/enumerate-mutants.mjs cf24bd8811f40e15c22c32e5f9df711728670347...HEAD --json --limit 10000`.

Evidence is under `tmp/pr-207-truncated-coverage/`: `failing.log`, `passing.log`, `pipeline.log`, `typecheck.log`, `run-mutants.py`, `mutations.log`, `mutant-1.log` through `mutant-6.log`, `continuation-passing.log`, `final-targeted.log`, `mutation-supervisor-rerun.log`, `mutation-real-rerun.log` and `ps-denied.log`.

Only the pipeline package's tests ran in the builder sandbox. The full `npm run check` gate did not run here; the host runs it. This fix pass leaves the implementation plan and comparison records unchanged.
