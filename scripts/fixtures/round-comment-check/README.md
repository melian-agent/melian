# REST answers for the round comment check

`scripts/round-comment-check.test.mjs` runs the check in AGENTS.md's "Commits and pull requests" over these files. Each was recorded on 2026-11-08 with `gh api` from Melian round run 42440138303 on [pull request #321](https://github.com/melian-agent/melian/pull/321):

| File | Request |
| --- | --- |
| `repository.json` | `repos/melian-agent/melian` |
| `run.json` | `repos/melian-agent/melian/actions/runs/42440138303` |
| `comment-github-actions.json` | `repos/melian-agent/melian/issues/comments/6716456344`, the round's comment as `github-actions[bot]` posted it |
| `user-melian-status-bot.json` | the `creator` of the `melian/review` status `melian-status-bot` set on `92be2ec4`, since the proxy refuses `users/` and `collaborators` |

No round had posted as `melian-status-bot` when these were recorded, so the test builds that comment from `comment-github-actions.json` with its `user` replaced by `user-melian-status-bot.json`. Replace it with the first comment a round posts as `melian-status-bot`.
