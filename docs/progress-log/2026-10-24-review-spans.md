# 2026-10-24: Spans between tasks

[Pull request #206](https://github.com/melian-agent/melian/pull/206) builds step 36. `PrepareSpans` times the review's work between durable tasks, from the CLI process's start to the verdict, and stores one `melian.prepare` record per revision. `melian telemetry` lists the spans after the stages, names each untimed gap over a second, and shows each model stage's model wait. [The decision](../decisions/2026-10-24-review-spans.md) records the span model.

A scripted review on the fake model proves no untimed gap over a second and no span over a task. The mutation inventory, with every claimed mutant run by hand, is in the pull request's report. Spans inside `static.enola`'s own task are deferred.
