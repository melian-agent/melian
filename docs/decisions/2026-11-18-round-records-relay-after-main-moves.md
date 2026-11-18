# A round's first records job relays after the default branch moves

Status: built for [issue #397](https://github.com/melian-agent/melian/issues/397), in [pull request #576](https://github.com/melian-agent/melian/pull/576). The maintainer ruled on 2026-11-18, in the coordinator's session.

Amends: [A round's first report finishes after the default branch moves](2026-11-08-round-report-finishes-after-main-moves.md), scoped to the `record` job

## Problem

The `record` job adds a round's records to `melian/state`. It began with the strict check of the `pending` and `round` jobs, which refuses any run whose commit the default branch has moved past. A round takes up to 150 minutes, and `main` merges several times an hour. So most rounds would post their report and never relay their records. Codex's adversarial review of pull request #576 found it.

## Decision

The `record` job's first step is the report job's first step, unchanged. A first attempt carries on after the default branch moves when the round job's `checked` output is the run's commit. A rerun, with `run_attempt` above 1, is refused once the default branch has moved past its commit. A workflow test holds the two steps identical.

## What differs, and why the job chain still holds

The report job declares the `melian-round` Environment and holds the status token. The `record` job declares no Environment, so it holds no login and no status token, but its token has `contents: write`.

The job chain bounds both the same way. `record` needs `round`, and it runs only when the round's records step named an artefact. That step comes after the round job's check that its commit was the default branch's head, so the code `record` runs was the reviewed default branch when the round began. The `checked` output says the same, and the step refuses a first attempt after a move without it.

A first attempt can therefore run, with `contents: write`, workflow code that `main` has since left, for the round's 150 minutes plus the wait to start. That code was `main` when the round began, and its rulesets check still refuses unless rulesets keep `main` and `melian/state`. A fix to the job that lands during a round misses that round's relay; a fresh dispatch runs the fix.
