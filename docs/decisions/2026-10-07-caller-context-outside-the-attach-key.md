# Advisory caller context stays outside the lens task's attach key

Choice: the lens task's attach key, the selection `selectionOf` builds and the instruction fingerprint inside it, holds no caller section. A repeat review of the same head attaches to the first call's lens task. That task's stored input carries the instructions the first call rendered, so the resumed lens keeps the first call's caller section.

Why: Caller context is advisory and best effort. `CallerContext.open` turns every failure into `unavailable`, a wall-clock deadline and live Enola impact queries shape what it renders, and a rerun can therefore render another section. Example: a review with callers is killed during a lens's first model request, and the rerun's graph query times out. Keyed on the section, the rerun missed the attach, cleared the earlier sightings, aborted the first task and ran every lens again. Keeping it out of the key makes the rerun resume.

Gives up: a changed caller section on the same head does not re-run lenses. `--rerun` does not refresh it either, since it replaces a task only when a lens failed. A new head, or a rerun after a failed lens, renders fresh context.

Replaces: the caller section in the attach key, which [pull request #89](https://github.com/melian-agent/melian/pull/89) added earlier on this branch.

## Caller notes and coverage IDs stay with the first call

Problem: each call wrote its own caller notes and coverage IDs into the lens records. Those records feed the adjudication input and `Verdict.toJSON().ran`, so they decide the adjudication attach key and the verdict fingerprint. Example: a review with a graph cache stored coverage IDs. The cache was cleared, and a repeat review of the same head got `Callers unavailable: …` notes and no IDs. It keyed a new adjudication task, fingerprinted a new verdict, and `melian publish` posted the same findings twice.

Choice: store them with the first call's lens task, and read them back on attach. The first call that finishes the lens task writes the per-lens caller notes and the coverage IDs, or the coverage-unavailable flag, to its `ReviewIndex` entry, which names that task and is replaced with it. A repeat call that finds them renders them in place of its own. The lens task outcome carries only the model's per-lens result, and coverage is computed from the lens conversations after the task ends, so the index entry is the record that already ties a head and selection to its task. The alternative, leaving them out of the records, would drop coverage IDs from the verdict, where they are worth keeping.

Gives up: a repeat review does not pick up a graph or coverage that became available after the first call, and a first call that found none keeps that note. A call whose lens task did not complete stores nothing, and a rerun that replaces a failed lens starts again with fresh context.
