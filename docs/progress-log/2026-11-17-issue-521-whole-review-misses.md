# Issue 521: a past miss measured with the whole review

[Issue #521](https://github.com/melian-agent/melian/issues/521).

## A prober's record keeps every skip

Codex's seventh review of [pull request #518](https://github.com/melian-agent/melian/pull/518), at 265bb34e, found that `TelemetryReader.proberRecord` dropped a skip's reason once the prober later probed the same attack. The record is the audit trail, so it now keeps every skip. The stage's `skipped` count still treats such an attack as probed.

The test came first. `probing-level.test.ts`, "shows the prober's plan size, its skips, and how each probe ended", skips attack 2 and then probes it. With the record expected to hold that skip, it failed at ded386ca with `-  "attack": 2, "reason": "it needs the network"` missing from the record. With the fix, it passed.

## A measurement names the lenses that probe

`MELIAN_EVAL_PROBE_LENSES` names the lenses a probing run gives the probing deep level, comma-separated, and defaults to `trust-boundary`, so a run without it repeats the first measurement. Every lens it names gets the same planner and prober routes. It applies to goldens and misses alike.

The run asks core whether each named lens may probe. `Lens.probeRefusal()` in `packages/core/src/lens.ts` returns the reason a level that set `probe` would be refused at load: `tests` until [issue #493](https://github.com/melian-agent/melian/issues/493) lands, and any lens without probing wording. `resolveLevels` and the new method share one function, so the evals package never restates the rule. A name the base's policy does not load is refused too, and so are a repeat and an empty list.

The tests came first. In `packages/core/test/lens.test.ts`, "says why a loaded lens may not probe" failed at b648f89c with `lens.probeRefusal is not a function`. In `packages/evals/test/probing.test.ts`, "probes each lens the run names" and "refuses a lens core would not let probe" failed because `ProbingCombination` ignored the list. With the change, all 148 core lens tests and all 60 probing tests pass.

## A golden's lines are answered at each claim's own sighting

[Pull request #518](https://github.com/melian-agent/melian/pull/518) gave an expectation `lines`, and four reviews each found a merged claim placed where it was not reported: at the speaker's place, at a cause in another file, at a cause the merge copied, and at a member's place that adjudication kept. Each fix read the best place the merged finding still held. The coordinator directed the fix, not a ruling: score a line-scoped expectation on each claim's own sighting, found by claim ID and version, and leave `melian.verdicts` unversioned.

Every review now returns each lens check's own sightings at the head, read level by level, in place of the one check a target named. `answers` places each claim of a finding at its own sighting: the members in `otherClaims`, and the speaker once for each check and level in `reportedBy`. A guardrail's claim is its own finding. A lens claim with no sighting throws, and so does scoring an expectation with lines without the sightings. An expectation without `lines` scores as before.

The tests came first. In `packages/evals/test/goldens.test.ts`, the describe block "an expectation with lines, answered at each claim's own sighting" ran against 5128206e's scorer in a throwaway worktree: four of its six tests failed. A member sighted at 11 with the speaker at 30 found 0, expected 1 (line 1399). A merged finding at a member's kept place 11, with the speaker sighted at 30, found 1, expected 0 (line 1428), Codex review 8's instance. A speaker reported by two levels, one sighted at 11, found 0, expected 1 (line 1439). Scoring without sightings did not throw (line 1484). The two that passed cover the cross-file instance and refuted claims, which the old scorer already handled. With the change, all 163 goldens tests and all 60 probing tests pass.
