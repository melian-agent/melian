# REST answers for the round comment check

`scripts/round-comment-check.test.mjs` runs the check in AGENTS.md's "Commits and pull requests" over these files, and `scripts/round-record.test.mjs` builds a record from the comment. Each was recorded on 2026-11-14 with `gh api` from Melian round run 43558730566 on [pull request #422](https://github.com/melian-agent/melian/pull/422), except `comment-github-actions.json`:

| File | Request |
| --- | --- |
| `repository.json` | `repos/melian-agent/melian` |
| `run.json` | `repos/melian-agent/melian/actions/runs/43558730566` |
| `comment-melian-status-bot.json` | `repos/melian-agent/melian/issues/comments/6872114855`, the round's comment as `melian-status-bot` posted it |
| `status-melian-status-bot.json` | one `melian/review` status `melian-status-bot` set, on `370a0224`, for its `creator` |
| `comment-github-actions.json` | `repos/melian-agent/melian/issues/comments/6716456344`, recorded on 2026-11-08 from run 42440138303 on [pull request #321](https://github.com/melian-agent/melian/pull/321), for the `user` `github-actions[bot]` posts as |

No round had recorded a comment's body when these were recorded, so the test builds each `melian/round-comment` status from `status-melian-status-bot.json`, keeping its `creator`. Replace it with the first record a round sets.
