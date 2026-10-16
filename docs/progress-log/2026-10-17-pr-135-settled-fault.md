# Preserve settled stages after an owning task faults

[Pull request #135](https://github.com/melian-agent/melian/pull/135), pass 3, F1. A later task fault replaced completed and failed conversation outcomes and stretched both intervals by an hour. The reader now takes a fault end only when the conversation has no settled end.

The two regressions use real faux submissions. Both failed before the fix and passed after it. Removing the new guard reproduces both failures; inverting it also fails both existing active/no-input fault tests. Logs and the inventory are under `tmp/stage-telemetry-pass3-*` and `tmp/stage-telemetry-inventory.md`.

The sandbox denies `ps`, which the automatic mutation runner requires. The coordinator must run `static.mutation` on the host. No live model ran. Step 31 remains built on the branch and awaiting review; the plan status is unchanged.
