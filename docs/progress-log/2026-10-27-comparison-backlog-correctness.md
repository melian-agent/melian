# Two owed correctness goldens

The comparison backlog now has goldens for C3 of [pull request #62](https://github.com/melian-agent/melian/pull/62) and finding 8 of [pull request #11](https://github.com/melian-agent/melian/pull/11). `correctness-duplicate-variant-key` preserves the shared-name map overwrite. `correctness-platform-path-separator` moves the original test's path classification into source code, where `correctness` owns `wrong-result`.

Each golden carries its source record, a declared input, changed-line evidence and a scripted finding. Only those two entries leave `BACKLOG.md`. No lens or production behaviour changes.

Validation: eight focused checks passed: the corpus inventory and all seven `correctness-*` scripted goldens. Both new snapshots were read. Executing the two bases returned the expected results; the seeded heads failed assertions; repaired copies passed. The Windows case used Node's `path.win32` implementation on Linux. Inverting both expected reporting sources to `lens.contracts` made the two golden checks fail with zero precision and recall; restoring them passed.

The full gate and three live passes over the correctness corpus remain for the coordinator. This entry does not claim a completed drain or a lens measurement. The existing design and plan status remain unchanged pending that measurement.
