# 2026-10-23: five learnings from the step-10 work

`AGENTS.md` now records five traps met on the step-10 pull requests: a cascade failure after a timeout in `decision-files.test.ts`, survivors hidden above a round's trailing lines, `ignoreStatic` and module-level mutants, the merge-group workflow's first run, and `gh pr create --base` after a parent merged. Each names its symptom, cause, and what to do.

A scratch-repository test showed the merge-group decision's admin bypass cannot work: the queue rule has no bypass, so every merge must use the queue. [A new decision](../decisions/2026-10-23-melian-review-outage-procedure.md) amends the bypass and its procedure. `melian/review` goes in a second ruleset with no bypass actors, and in an outage the maintainer disables that ruleset, enqueues, and re-enables it. `docs/design.md` says so.
