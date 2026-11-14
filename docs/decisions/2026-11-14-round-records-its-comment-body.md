# A round records its comment's body as a status

Status: built for [issue #286](https://github.com/melian-agent/melian/issues/286). The maintainer approved the design on 2026-11-14, relayed by the coordinator to the builder's session.

Amends: [The round's comment comes from the machine user](2026-11-08-round-comment-as-the-machine-user.md), what the comment check binds and what `melian-status-bot` posts.
Amends: [An Actions round sets melian/review, and builders queue](2026-11-07-actions-round-sets-melian-review.md), the report job's steps.

## Problem

The check in AGENTS.md tied a `melian round` comment to its run, but not to what the run said. A writer, or any workflow whose token can write pull requests, can edit `melian-status-bot`'s comment and keep its marker. Example: a writer edits a round's comment on their own pull request to read "No findings above advisory." The check still passed, because the author, the run and the marker were unchanged, so AGENTS.md told builders to treat every round's findings as a writer's unverified text.

## Decision

- After it posts or edits the comment, the report job keeps GitHub's answer, not the file it sent, and hashes the body GitHub stored with SHA-256.
- It records the hash as a commit status: context `melian/round-comment`, state `success`, description `run <run ID> pull <number> body sha256 <hash>`, linked to the comment. The status goes on the commit the run built, `github.sha`, which the run's own REST record names as `head_sha`.
- Only `MELIAN_STATUS_TOKEN` sets it, in a step of its own after `melian/review` is set. The step hands the token to its `gh` write alone, as the comment and status steps do.
- The AGENTS.md check takes the pull request's number as a third argument. It accepts a comment only when the comment is on that pull request and its body hashes to the description of the `melian/round-comment` status with the highest ID that `melian-status-bot`, by login and account ID, set for that run on the run's commit. The marker only locates the comment.
- `scripts/timeline.mjs` still reads the spend line from any `melian-status-bot` round comment without the record. It sums minutes and cost for a person to read, and decides nothing.

## Why a status

GitHub lets no one edit or delete a commit status, and records which account set it. Only the default branch's round holds the token that sets one as `melian-status-bot`. So a status that account set is the run's own record, and a later edit of the comment cannot change it.

Two other places were weighed. The run's artefact cannot be read from a cloud session, whose proxy refuses GitHub's blob storage. A second comment, or the job's log, can be edited or deleted by a writer, or read only with the artefact's access.

The record takes the highest ID, not the newest time, as [the Actions round decision](2026-11-07-actions-round-sets-melian-review.md) does for `melian/review`: IDs only grow, and two statuses can share a second. A rerun of the report job edits the run's comment and records the new body, so its record wins.

The record names the pull request because a status names a commit, and one run's commit, the default branch's, carries the records of every pull request reviewed from it.

## What changes for branch protection

`melian/round-comment` lands on a commit of the default branch, not on a pull request's head. Branch protection on `main` requires `check (22)`, `check (24)`, `check (26)` and `melian/review`; the merge queue requires all of them green; and `melian status merge-group` copies only `melian/review` from the pull request's head. None of them reads the new context, and a `success` status cannot fail a required check.

## What this gives up

- A run cut off between the comment and the record leaves a comment the check refuses. A builder starts a new round.
- Between a rerun's edit and its record, the check refuses the edited comment, because the latest record still holds the old body.
- GitHub keeps at most 1,000 statuses per commit and context. A post past that fails the step, and the check refuses the comment.
- A comment that passes shows what the default branch's build posted. It does not show that the round reviewed the pull request's current head; the comment's first line names the head it reviewed.
- Whoever holds `MELIAN_STATUS_TOKEN` can still set a record the check accepts. That is the maintainer, as with any secret, and the steps named above.
- The workflow runs only from the default branch, so the first record comes after this change merges.
