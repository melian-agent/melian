# A lens run is the model and level that ran

Status: ruled on 2026-11-08 by the maintainer, in the builder's session for plan step 37 ([issue #243](https://github.com/melian-agent/melian/issues/243)).

## Context

The review index keys each lens run by its lens, version and level, its thinking, its band, its escalation, and the models its route resolved to. A review whose run has the same key attaches to the stored task instead of asking a model again. The plan judges the run afresh, so its lineage reads the new plan.

Melian's rounds on [pull request #339](https://github.com/melian-agent/melian/pull/339) found two inputs that never enter the key. The first is who set the route: a committed tier, a lens route, a preference file or `--model`. The second is which named credential the plan chose for each model. Example: a run on the committed `heavy` tier falls back to model B. A preference file then routes the lens to B, and the next review attaches to that run and records lineage moved by the preference file, though the stored run never moved. [The review plan resolution decision](2026-10-05-review-plan-resolution.md), since superseded, said a task is reused only for the same routes, so the lineage always names the route that ran, and `docs/design.md` still promised it. Neither instance kept that promise, on `main` or on this branch.

## Decision

A lens run is identified by what ran: the lens and its version, the level, the thinking, and the models it ran on, with the band and escalation as before. Who set the route does not enter the key, and nor does the credential. A review whose plan resolves to the same key reuses the stored run.

The lineage a reused run carries describes the plan of the review that reads it: the files and flags that put the model there now. It does not record which file put the model there when the run first happened. A review under a plan that resolves to other models or thinking still runs the lens again.

## Why

The answer a lens gives depends on the model and the level it ran at, not on which file chose the model or which login paid for it. Keying by the route's source or credential would rerun a lens, at a model's cost, for an answer that cannot differ.

## Consequences

- The fix pass that added the lens route's source to the key on [pull request #339](https://github.com/melian-agent/melian/pull/339) is reverted, so the key is the one `main` builds.
- `docs/design.md` and the pipeline guideline say that a run is reused for the same models and level, and that lineage reads the current plan.
- A run reused under a changed preference file or credential records the current plan's lineage, which can name a file that did not choose the model when the run happened.
