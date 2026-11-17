# Issue 521: a past miss measured with the whole review

[Issue #521](https://github.com/melian-agent/melian/issues/521).

## A prober's record keeps every skip

Codex's seventh review of [pull request #518](https://github.com/melian-agent/melian/pull/518), at 265bb34e, found that `TelemetryReader.proberRecord` dropped a skip's reason once the prober later probed the same attack. The record is the audit trail, so it now keeps every skip. The stage's `skipped` count still treats such an attack as probed.

The test came first. `probing-level.test.ts`, "shows the prober's plan size, its skips, and how each probe ended", skips attack 2 and then probes it. With the record expected to hold that skip, it failed at ded386ca with `-  "attack": 2, "reason": "it needs the network"` missing from the record. With the fix, it passed.

## A measurement names the lenses that probe

`MELIAN_EVAL_PROBE_LENSES` names the lenses a probing run gives the probing deep level, comma-separated, and defaults to `trust-boundary`, so a run without it repeats the first measurement. Every lens it names gets the same planner and prober routes. It applies to goldens and misses alike.

The run asks core whether each named lens may probe. `Lens.probeRefusal()` in `packages/core/src/lens.ts` returns the reason a level that set `probe` would be refused at load: `tests` until [issue #493](https://github.com/melian-agent/melian/issues/493) lands, and any lens without probing wording. `resolveLevels` and the new method share one function, so the evals package never restates the rule. A name the base's policy does not load is refused too, and so are a repeat and an empty list.

The tests came first. In `packages/core/test/lens.test.ts`, "says why a loaded lens may not probe" failed at b648f89c with `lens.probeRefusal is not a function`. In `packages/evals/test/probing.test.ts`, "probes each lens the run names" and "refuses a lens core would not let probe" failed because `ProbingCombination` ignored the list. With the change, all 148 core lens tests and all 60 probing tests pass.
