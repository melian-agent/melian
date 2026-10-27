# Two owed correctness goldens

The comparison backlog now has goldens for C3 of [pull request #62](https://github.com/melian-agent/melian/pull/62) and finding 8 of [pull request #11](https://github.com/melian-agent/melian/pull/11). `correctness-duplicate-variant-key` preserves the shared-name map overwrite. `correctness-platform-path-separator` moves the original test's path classification into source code, where `correctness` owns `wrong-result`.

Each golden carries its source record, a declared input, changed-line evidence and a scripted finding. Only those two entries leave `BACKLOG.md`. No lens or production behaviour changes.

Validation: eight focused checks passed: the corpus inventory and all seven `correctness-*` scripted goldens. Both new snapshots were read. Executing the two bases returned the expected results; the seeded heads failed assertions; repaired copies passed. The Windows case used Node's `path.win32` implementation on Linux. Inverting both expected reporting sources to `lens.contracts` made the two golden checks fail with zero precision and recall; restoring them passed.

The [three-pass measurement](../../packages/evals/runs/2026-10-27-live-correctness-backlog-drain.md) ran at `d6963c43` over all seven `correctness-*` goldens. The corpus meets the precision and recall bars. The run record preserves the scores, extras, model routes and observed reasoning levels. No lens was retuned and no fixture changed. The plan links this measured status. The full gate, formal reviews and CI on the final head remain for the coordinator.
