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

## What can write the checked records before the upload

The round job checks a copy of its records with `melian records relay --check`, then uploads that copy as a public artefact. Melian's second round on pull request #576 asked what writes the copy in between. A process the head's code left running would publish bytes no check read.

None can. In the round job, the head's code runs only inside the probe sandbox. sandbox-runtime confines a probe, and every process it starts, to writes under the probe's own scratch (`write: [run]` in `packages/pipeline/src/probe.ts`). So a probe that outlives the review still cannot write to `$RUNNER_TEMP/checked-records`.

Two more tools touch the head's files outside the sandbox: Biome and tsc on the head's checkout. Neither runs the head's code. Each comes from the round job's `npm ci` of the default branch, since `staticToolSource` prefers the checkout's install and that checkout is the default branch's. Each reads the head's configuration as data. A Biome plugin is a GritQL pattern that Biome matches in its own process, and tsc's command line loads no plugin a `tsconfig.json` names. Neither tool starts a child process, so neither can leave one running. The mutation check, which would run the head's tests unconfined, is off the tiers and skips without `--trust-head`, which the workflow never passes. Enola runs Melian's verified executable, with executable providers disabled.

A process that could write there unconfined would leak through `$RUNNER_TEMP/public` as well, which the same job uploads under `always()`. So the records artefact adds no channel. An archive written by the check would not help, since any process of the same user could rewrite it too. The maintainer's read of the finding is pending.

The relay reads each record file by its path after it lists the store, so a writer working alongside it could swap a file, or a folder above it, for a link between the two. Melian's round at 01ed40f1 raised this. No such writer runs in either job. The record job runs no head code, and download-artifact has finished before the relay step starts. In the round job, the check is the case above: the head's code runs only inside the probe sandbox. Refusing a link on the final open alone would leave a folder higher up open to a swap, and Node has no `openat`, so a full fix would need a reader that walks descriptors, against a writer that does not exist. The maintainer's read of this finding is pending with the one above.

## Which base the relay checks, and whose policy it reads

The gate passes the base and head it approved as `--expect-base` and `--expect-head`. The relay required the pull request's base to still be `--expect-base`, so once `main` moved during a round, the relay refused and the round's records were lost. Melian's round at 01ed40f1 found it. The maintainer's ruling of 2026-11-18, that a merge during a round keeps its records, decides the fix; the coordinator approved this form.

The relay and the round job's `--check` call one guard, `checkApproved` in `packages/cli/src/target.ts`, so the two cannot disagree. It refuses unless all of these hold:

- The pull request still merges into the repository's default branch, as the same read of the pull request reports it. The `melian round` workflow reviews only such a pull request, and refuses one stacked on another branch, because that base would supply the policy. A pull request retargeted after its round is now one the workflow would refuse, so its records must not be relayed under that round's name. The message says to start a new round. A provider that does not report the default branch is refused too.
- Both approved values are whole commit IDs. A branch name such as `main` would resolve to the tip, and the relay would then read the tip's policy.
- The pull request's head, and the revision Melian fetched, are the approved head. A head that moved, was force-moved or was rebased names records no round produced.
- The approved base is in the history of the pull request's base. A base rewritten without it, or retargeted to a branch that lacks it, no longer describes the round.
- The revision diffs from the merge base that the approved base and head share. When `main` takes one of the head's commits, the merge base moves, and so does the diff, though the head and the base's history still hold.

The relay reads policy, `trust.writers` and the tier from the approved base, not from the base's tip. The approved base is the commit the round's review read. The relay must judge the records under the policy that produced them. A later `main` might trust writers the round did not, or select another tier, and neither should decide records made before it.

One case passes on purpose. An approved base older than the tip, but no older than the merge base, relays under its own policy. The gate supplies the base it approved, so the relay need not doubt it, and a writer could push to `melian/state` directly in any case.
