# Issue 521: a past miss measured with the whole review

[Issue #521](https://github.com/melian-agent/melian/issues/521).

## A prober's record keeps every skip

Codex's seventh review of [pull request #518](https://github.com/melian-agent/melian/pull/518), at 265bb34e, found that `TelemetryReader.proberRecord` dropped a skip's reason once the prober later probed the same attack. The record is the audit trail, so it now keeps every skip. The stage's `skipped` count still treats such an attack as probed.

The test came first. `probing-level.test.ts`, "shows the prober's plan size, its skips, and how each probe ended", skips attack 2 and then probes it. With the record expected to hold that skip, it failed at ded386ca with `-  "attack": 2, "reason": "it needs the network"` missing from the record. With the fix, it passed.
