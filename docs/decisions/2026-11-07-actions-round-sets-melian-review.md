# An Actions round sets melian/review, and builders queue

Status: built for [issue #304](https://github.com/melian-agent/melian/issues/304), by the maintainer's rulings on 2026-11-07.

Amends: [Actions rounds run only the default branch's code with the logins](2026-11-06-actions-rounds-run-default-branch-code.md), which jobs declare the `melian-round` Environment.
Amends: [An unresolved acknowledgement fails the status, as built](2026-10-17-acknowledge-status-exact-rule.md), the status an Actions round sets.
Amends: [Builders run Codex's adversarial review and their own Melian rounds](2026-11-05-builders-run-their-own-reviews.md), who marks a pull request ready and queues it.

## Problem

A builder could run its own Melian round in Actions, but could not land without the coordinator. `main` requires `melian/review`, and only `melian publish` set it, from a store in the coordinator's clone. Example: [pull request #300](https://github.com/melian-agent/melian/pull/300) ran a round, found nothing blocking, and still waited for the coordinator ([its report](https://github.com/melian-agent/melian/pull/300#issuecomment-6705524907)).

The status needs no store. Only the inline review and the ledger need the store's marker secret.

## Decision

The round's report job sets `melian/review` on the head the gate approved, from the round's verdict:

- `success` when the verdict passed, or found nothing blocking. The description counts the findings to acknowledge.
- `failure` when a finding blocks.
- `error` when the round did not review that head, or its verdict cannot be read.

It re-reads the pull request first and sets no status when the base or head moved. It sets none either when the head's latest `melian/review`, read across every page, is not the `pending` status this round set, compared by the status's ID. So a rerun of the report job alone never puts an older verdict back over a later round's or a host's. Round 5 found that comparing times failed both ways: GitHub's clock and the runner's differ, and both keep whole seconds, so a status set in the same second could be overwritten, and skew could make the round's own `pending` look newer and leave it standing. A read that fails sets `error`, never nothing: the pull request's, the statuses', or a pending ID the job did not hand on. Skipping would leave an earlier `success` standing on a head this round may have failed.

Before the round job starts, a `pending` job in the `melian-round` Environment sets `melian/review` to `pending` on the gate's head, by the maintainer's ruling after round 3. Example: a round finds a block, but its report job's install fails, so the status step never runs. Without the pending status, the head kept round 1's `success`, and the merge group copied it. With it, the head shows `pending`, which the merge group refuses. A missing `MELIAN_STATUS_TOKEN` fails that job, so the round does not run. The gate also refuses a head another open pull request shares: a status names a commit, not a pull request, so two pull requests on one head would overwrite each other's `melian/review`.

GitHub keeps a commit's latest status and offers no compare-and-set. So a host publication can still land between the report's read of the latest status and its post, and the report's older `success` then replaces it. The maintainer accepted that window of a few seconds. Two writers can already race on this status under the writer-trust decision. Closing it needs one serialised publisher, or a status bound to a round identity the merge group can check, which waits for milestone 3's state branch. The pending job checks that the default branch has not moved past the run's commit before anything holds the token, as the round and report jobs do.

It reads `trust.writers` from the committed root policy at the pull request's base, with core's loader, as `melian publish` does, and sets `error` when writers are not trusted or the policy cannot be read: "Not reviewed here: writers are not trusted; a trusted host sets this status". With trust off a writer's head is not trusted, and its code runs in the round job beside the verdict, so no Actions round may vouch for it until milestone 3's trusted host. The status takes the shape `melian publish` sets: the pull request as its target, and a description ending `; base <the merge base the round reviewed>`.

The merge group copies a head's status only when its creator is a User with write permission. A status set with `GITHUB_TOKEN` is created by `github-actions[bot]`. So is a status from any branch's workflow with `statuses: write`, so that creator could not tell `main`'s round from a forgery. The maintainer chose a dedicated identity: a machine user with write permission, whose fine-grained token covers this repository's commit statuses alone. The token is the `melian-round` Environment's secret `MELIAN_STATUS_TOKEN`, so only `main`'s workflow reads it. The merge-group rule is unchanged: a writer's status counts. A human writer could already set the status by hand, and still can, as the trust decision allows.

The report job declares the Environment, so it can read that secret, and the secret reaches only its status step. The job runs no head code. The model logins stay in the round job.

An acknowledge finding does not fail this status, by the maintainer's ruling. The builder asks the maintainer in its own session to read the finding, records the maintainer's read on the pull request, then marks it ready and queues it. `melian publish` keeps the amended decision's rule: an unresolved acknowledgement fails the status it sets.

The builder, not the coordinator, now marks its pull request ready and queues it, by the same ruling. The coordinator still runs the host round a dismissal or the comparison record needs. The maintainer's read of acknowledge findings is the independent step before the queue, and a blocking finding still needs a fix or a dismissal through a host round.

## What this gives up

The inline review and the ledger stay host-only until milestone 3's state branch. The Actions status rests on the machine user's token, as a publication rests on the maintainer's: whoever holds the token can set the status.
