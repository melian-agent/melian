# 2026-10-23: five learnings from the step-10 work

`AGENTS.md` now records five traps met on the step-10 pull requests: a cascade failure after a timeout in `decision-files.test.ts`, survivors hidden above a round's trailing lines, `ignoreStatic` and module-level mutants, the merge-group workflow's first run, and `gh pr create --base` after a parent merged. Each names its symptom, cause, and what to do.

A scratch-repository test showed the merge-group decision's admin bypass cannot work: the queue rule has no bypass, so every merge must use the queue. [A new decision](../decisions/2026-10-23-melian-review-outage-procedure.md) amends the bypass and its procedure. `melian/review` goes in a second ruleset with no bypass actors, and in an outage the maintainer disables that ruleset, enqueues, and re-enables it. `docs/design.md` says so.

Fix pass 1 rewrote the outage procedure after two probes on the scratch repository. Disabling the ruleset lets any armed pull request enqueue itself on the next event, and re-enabling it early holds the chosen group until the queue ejects it. The procedure is now a maintainer override on one pull request, with the ruleset active, and disabling is a bounded fallback. It also corrects the static-mutant learning: a purely static mutant is `Ignored`, and these are `Survived` mutants Stryker also reached at module load.
