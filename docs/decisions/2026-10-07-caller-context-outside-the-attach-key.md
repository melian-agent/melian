# Advisory caller context stays outside the lens task's attach key

Choice: the lens task's attach key, the selection `selectionOf` builds and the instruction fingerprint inside it, holds no caller section. A repeat review of the same head attaches to the first call's lens task. That task's stored input carries the instructions the first call rendered, so the resumed lens keeps the first call's caller section.

Why: Caller context is advisory and best effort. `CallerContext.open` turns every failure into `unavailable`, a wall-clock deadline and live Enola impact queries shape what it renders, and a rerun can therefore render another section. Example: a review with callers is killed during a lens's first model request, and the rerun's graph query times out. Keyed on the section, the rerun missed the attach, cleared the earlier sightings, aborted the first task and ran every lens again. Keeping it out of the key makes the rerun resume.

Gives up: a changed caller section on the same head does not re-run lenses. `--rerun` does not refresh it either, since it replaces a task only when a lens failed. A new head, or a rerun after a failed lens, renders fresh context.

Replaces: the caller section in the attach key, which [pull request #89](https://github.com/melian-agent/melian/pull/89) added earlier on this branch.
