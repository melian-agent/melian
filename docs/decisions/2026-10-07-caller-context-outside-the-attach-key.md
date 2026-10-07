# Advisory caller context stays outside the lens task's attach key

Choice: the lens task's attach key, the selection `selectionOf` builds and the instruction fingerprint inside it, holds no caller section. A repeat review of the same head attaches to the first call's lens task. That task's stored input carries the instructions the first call rendered, so the resumed lens keeps the first call's caller section.

Why: Caller context is advisory and best effort. `CallerContext.open` turns every failure into `unavailable`, a wall-clock deadline and live Enola impact queries shape what it renders, and a rerun can therefore render another section. Example: a review with callers is killed during a lens's first model request, and the rerun's graph query times out. Keyed on the section, the rerun missed the attach, cleared the earlier sightings, aborted the first task and ran every lens again. Keeping it out of the key makes the rerun resume.

Gives up: a changed caller section on the same head does not re-run lenses. `--rerun` does not refresh it either, since it replaces a task only when a lens failed. A new head, or a rerun after a failed lens, renders fresh context.

Replaces: the caller section in the attach key, which [pull request #89](https://github.com/melian-agent/melian/pull/89) added earlier on this branch.

## Caller notes and coverage IDs stay with the first call

Problem: each call wrote its own caller notes and coverage IDs into the lens records. Those records feed the adjudication input and `Verdict.toJSON().ran`, so they decide the adjudication attach key and the verdict fingerprint. Example: a review with a graph cache stored coverage IDs. The cache was cleared, and a repeat review of the same head got `Callers unavailable: …` notes and no IDs. It keyed a new adjudication task, fingerprinted a new verdict, and `melian publish` posted the same findings twice.

Choice: store them with the first call's lens task, and read them back on attach. The first call that finishes the lens task writes the per-lens caller notes and the coverage IDs, or the coverage-unavailable flag, to its `ReviewIndex` entry, which names that task and is replaced with it. A repeat call that finds them renders them in place of its own. The lens task outcome carries only the model's per-lens result, and coverage is computed from the lens conversations after the task ends, so the index entry is the record that already ties a head and selection to its task. The alternative, leaving them out of the records, would drop coverage IDs from the verdict, where they are worth keeping.

Gives up: a repeat review does not pick up a graph or coverage that became available after the first call, and a first call that found none keeps that note. A call whose lens task did not complete stores nothing, and a rerun that replaces a failed lens starts again with fresh context.

## The records derive from the task's stored input

Problem: a lens that attached to a crashed task reads the first call's section, but the call that finishes the task wrote its own notes and coverage. Example: call 1 renders a caller section and is killed in the first model request. Call 2 has no graph, attaches, and finishes the task. Its record then says `Callers unavailable` and carries no coverage, though the lens read the callers.

Choice: when it creates a lens task, a review with Enola enabled stores the caller notes per lens and the coverage source (graph key parts, extra paths and cache root) in the task's input, beside the instructions they describe. `callersFor` derives the record from the input of the task that ran, never from the finishing call's `options.callers`. The index entry still keeps the first finished record. The input field is optional and the task version stays at 3: a task without it, created by an older Melian or a review without Enola, falls back to the finishing call's context, as before.

Gives up: coverage is computed from the first call's graph identity even if the cache entry has since gone; it then records coverage unavailable.

