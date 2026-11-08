# The round's comment comes from the machine user

Status: built for [issue #323](https://github.com/melian-agent/melian/issues/323). The maintainer ruled on 2026-11-08, in the builder's session, that the comment check runs on REST alone, as [the issue records](https://github.com/melian-agent/melian/issues/323#issuecomment-6716668961).

Amends: [An Actions round sets melian/review, and builders queue](2026-11-07-actions-round-sets-melian-review.md), which token the report job writes with and who posts the round's comment.
Amends: [Builders run Codex's adversarial review and their own Melian rounds](2026-11-05-builders-run-their-own-reviews.md), how a builder tells a round's comment from any other.

## Problem

The `melian round` workflow posted its comment as `github-actions[bot]`. Every workflow in the repository posts as that login, a writer's branch copy of this one included, so the login told a builder nothing. The check in AGENTS.md tied a comment to its run by a nonce the run uploaded as an artefact. A cloud session cannot download artefacts: its proxy refuses GitHub's blob storage. Example: on [pull request #321](https://github.com/melian-agent/melian/pull/321) the check could not finish for round run 42440138303, so its builder read the comment unverified.

## Decision

- The report job posts, finds and edits the round's comment with `MELIAN_STATUS_TOKEN`, the token of the machine user `melian-status-bot`, which already sets `melian/review`. It reads the secret only through the `melian-round` Environment, whose deployment branches are the default branch alone. An empty secret fails the comment step before it posts, with the status step's error.
- A rerun of the report job alone edits the comment whose marker names the run and whose author is `melian-status-bot`. A comment with that marker from any other login is never edited.
- The report job's own `github.token` only reads: its `pull-requests` permission drops from `write` to `read`. Nothing in that job posts as `github-actions[bot]`.
- A builder reads a round's comment only when the AGENTS.md check accepts it:
  - its author is `melian-status-bot`;
  - its run is a `workflow_dispatch` run of `.github/workflows/melian-round.yml` on the current default branch;
  - its marker names that run.
- The check reads only the REST API. The marker still carries the run's nonce, but the check no longer reads it.
- `melian-status-bot` has write permission, but its login grants no authority on any artefact. It posts nothing but round comments and `melian/review` statuses.

## Why the nonce can go

The nonce told one `github-actions[bot]` comment from another, since any workflow could post one naming any run. The login now does that job. Only `MELIAN_STATUS_TOKEN` posts as `melian-status-bot`. Of the jobs that declare the `melian-round` Environment, only the pending job's status step and the report job's comment and status steps read the token. None of them runs head code, and the round job, which runs the head's code, never reads it. A branch's copy of the workflow, run with `--ref`, cannot deploy to the Environment, so it never receives the secret. A comment that passes the check was therefore posted by the default branch's round. The nonce would add nothing an attacker without the token could not already meet: a comment they post fails the login check first.

## What this gives up

- The check still binds a comment to its run, not its body. A writer, or a workflow whose token can write issues or pull requests, can edit `melian-status-bot`'s comment after it posts and keep its marker. [Issue #286](https://github.com/melian-agent/melian/issues/286) tracks binding the body.
- Whoever holds `MELIAN_STATUS_TOKEN` can post a comment the check accepts. That is the maintainer, as with any secret, and the three steps above.
- The workflow runs only from the default branch, so this change's first recorded run comes after it merges.
