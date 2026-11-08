# A round's first report finishes after the default branch moves

Status: built for [issue #335](https://github.com/melian-agent/melian/issues/335). The maintainer ruled on 2026-11-08, in the coordinator session, to refuse reruns only. After the attacking review below, the maintainer ruled the same day, in the builder's session, to relax the report job alone.

Amends: [Actions rounds run only the default branch's code with the logins](2026-11-06-actions-rounds-run-default-branch-code.md), its refusal of a run whose default branch has moved past the run's commit

## Problem

The `pending`, `round` and `report` jobs of the `melian round` workflow each began by refusing a run whose commit the default branch had moved past. The check keeps a rerun from building old workflow code with the logins, since a rerun keeps its first commit. But `main` merges several times an hour, and a round takes minutes to more than an hour.

Example: [pull request #294](https://github.com/melian-agent/melian/pull/294)'s round 2, run 42442674728, reviewed for 11 minutes. `main` moved past `e5c89a05` during the round, the report job refused the run, and the round posted nothing.

## Decision

- `report` carries on after the default branch moves, in a run's first attempt whose round job passed its own check on the run's commit. It still refuses a rerun, with `run_attempt` above 1, whose commit the default branch has moved past.
- `pending` and `round` keep the strict check. They start seconds after the gate, so a merge refuses them rarely, and cheaply, before any review.
- Every job still refuses a run from any ref but the current default branch, whatever its attempt.
- The report job refuses an attempt that is not a whole number above 0. It also refuses a default branch or head it cannot read; a head reads only as 40 hexadecimal digits. Each read fails closed.

A first attempt's report is safe to run on its commit because of the job chain. `report` needs `round`, and `round` checks, as it starts, that its commit is the default branch's head. So the code `report` runs was the reviewed default branch when the round began.

That holds only when the round's check passed, and `report` runs under `always()`, so it also runs after `pending` refused the run or `round` was skipped. So `round` publishes the commit its check passed on, as the job output `checked`, from a step straight after the check. `report` carries on after a move only when that output is the run's commit. A run that `pending` refused, or whose round failed before the check, leaves the output empty, and the strict rule holds.

## What this gives up

A workflow fix that lands during a round misses that round's report job. The round job's timeout bounds that at 150 minutes, plus the time the report job waits for a runner. A rerun or a fresh dispatch runs the fix.

## The attacking review

A separate agent attacked the first ruling, under which every job's first attempt carried on, before anything was built. [Its report](https://github.com/melian-agent/melian/issues/335#issuecomment-6718338111) is on the issue. It cites GitHub's documentation from a clone of github/docs, since the session could not reach docs.github.com.

- **A run held by the workflow's own concurrency group.** `melian-round-<pull request>`, with `cancel-in-progress: false`, holds one run while the run ahead of it finishes. That can take up to 165 minutes of timeouts, plus runner queues. GitHub fixes `github.sha` when the run is created. Under the first ruling, a held run's `pending` and `round` jobs would run, with the logins, code the default branch had left hours before. This decision keeps both strict, so a held run is refused before its round.
- **Delayed jobs.** A runner queue, an Environment wait timer or a required reviewer can hold any first-attempt job. Under this decision, only `report` can start on a moved commit, and its delay counts against the residual above.
- **The premise.** The first ruling said the Environment admitted the commit at dispatch. The Environment matches the run's ref, not its commit, so it bounds no age. This decision bounds age through the job chain instead.
- **No rerun gives `run_attempt` 1.** GitHub's documentation says the attempt starts at 1 and rises with each rerun: of all jobs, of failed jobs, or of one job. No step can change it before the check, since it comes from the `${{ }}` expression.
- **Shell traps.** `[ "$ATTEMPT" -gt 1 ]` and `(( ATTEMPT > 1 ))` let an empty or non-numeric attempt through, and `(( ))` runs an injected `a[$(cmd)]`. The step matches the attempt against `^[1-9][0-9]*$` and compares it as text, and its test covers each of those inputs.

Codex's adversarial review of the first build found the `always()` gap above. A run held in the queue reached `pending` after `main` moved. `pending` refused it, and `round` was skipped, but the first build's `report` still ran the old commit with a token that can write comments. The `checked` output closes it, and the step's test covers an empty and a wrong output.

The agent also proposed bounding the report's age by reading, from the repository's activity, when the default branch left the run's commit. The maintainer chose the job chain's bound, which needs no new read.
