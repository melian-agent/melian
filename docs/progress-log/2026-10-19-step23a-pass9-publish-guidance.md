# Step 23a pass 9: align publication guidance with the triage guard

[Pull request #152](https://github.com/melian-agent/melian/pull/152), finding `658268b5a96e261e`.

The pipeline guideline and the comment above `undecidedVerdict` now describe the task-side refusal. A revision without indexed adjudication ends the publish task superseded as review in progress. The user must publish again after adjudication finishes.

The preflight still checks findings freshness. The resumed task supplies the final index guard before external effects. This change corrects prose; it adds no behaviour or guard.
