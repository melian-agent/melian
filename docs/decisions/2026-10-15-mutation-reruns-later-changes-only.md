# The mutation check reruns only what changed since the last judged head

Problem: `static.mutation` keys its incremental cache by the exact head commit, so every push starts cold over the whole pull request. A fix that touches one line pays for every mutant on the branch again.

Example: on [pull request #98](https://github.com/melian-agent/melian/pull/98), each new head re-ran about 1,050 mutants in 22 files. Round ten's cold run fitted inside the provisional 7,200-second timeout. Round twelve's took 8,466 seconds and read `not reviewed` for the timeout alone, though every lens and the verifier found nothing above advisory.

Choice: the maintainer's words, "Once we found the mutation gaps for a changeset, we should only run it again on the following changes, not the full PR changeset". Results carry across a pull request's heads, and Stryker's incremental mode, not Melian, decides which mutants run again. Until this is built, [the mutation decision](2026-10-08-mutation-testing-as-a-static-check.md)'s per-head partition stands.

This decision records the problem and the direction only. The step that builds it, plan step 22, writes the full decision against the code first, superseding the mutation decision's cache clause with every other clause restated, and has it attacked before any code. Designing the key and the trust rules here, ahead of the step, drew a new hole in each review of this decision; [the convergence rules](2026-10-15-review-loop-convergence-rules.md) say to stop at that point.

Open questions for the step:

- The partition key. It holds only what stays fixed across a pull request's heads, such as repository, base policy, installation and the review's target; the mutate entries change with every head and belong to a run. Found by Codex's adversarial review of [pull request #122](https://github.com/melian-agent/melian/pull/122).
- Both runs trusted alike. A run reuses another's results only when both heads were trusted in the same way, both a writer's or both vouched for with `--trust-head`, as each run's stored `WriterTrust` records. From the same review.
- The plant-then-revert forgery. A head can add a test hook that throws only while a mutant is active, so every mutant reads `Killed`, and a later head can revert the hook. Stryker reruns only changed lines and tests, so the planted results survive, and the final diff a human reviews shows nothing. Found by Melian's fourth round on [pull request #122](https://github.com/melian-agent/melian/pull/122).
- Whether the final run reuses the cache. Running it cold closes the forgery above at the cost of one full run per pull request; reusing it keeps the speed. [Readiness question 16](../readiness-check-questions.md) puts it to the maintainer.
- Publication only from a descendant head. Several heads' runs share one partition, so a late run of an older head, such as one resumed after a crash, must never publish over a newer head's results. Found by the same round.
- What starts cold: a force-push that drops the last judged head, a base change, and an installation change.
