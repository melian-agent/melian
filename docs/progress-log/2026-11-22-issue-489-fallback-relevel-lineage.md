# Issue 489: lineage for a relevelled fallback, and escaped route errors

Round 44976616923 on [pull request #536](https://github.com/melian-agent/melian/pull/536) found two gaps.

- A preference file that listed a committed `{ model, thinking: medium }` fallback as a bare model ran it at the route's `low`, and lineage named neither level. The plan now records, on each model whose fallback entry names a level on either side, the level it runs at, its committed entry's level and the file that changed it, and lineage takes that for the model that answered. Doctor prints it. The coordinator chose this over a decision that a fallback owes only its own level.
- `checkRouteLevels` put a fallback's model name from `melian.yaml` into its error unescaped, so ESC and U+202E reached the terminal.

Each fix started from a failing test; the pull request's report has both runs and the hand mutation proof for the plan change.
