# Failed summary tasks stop at the retry limit

[Pull request #73](https://github.com/melian-agent/melian/pull/73), round eleven, item 1: confirmed. The retry tests covered completed tasks without summaries, but not terminal failed tasks.

A regression now runs two distinct summary tasks to terminal `failed` outcomes across two reviews. The third review starts no task and keeps the fixed failure note. Removing the attempt count before the limit check makes the test start a third task and fail.

The replacement test task must define `spawn`, the phase stored when `SummaryTask` creates it. Defining only `fail` faults the task before its intended failure phase runs. Assert the stored terminal outcome to distinguish the two paths.

Validation: all 15 walkthrough tests pass. The mutation test fails when the counting guard is removed; the source is restored afterwards. The repository gate passes: 50 test files, 1,218 tests passed, one skipped and zero vulnerabilities.
