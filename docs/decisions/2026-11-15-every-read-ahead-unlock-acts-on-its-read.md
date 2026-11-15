# Every read-ahead credential unlock acts only on what its read found

Amends: [A lens run is reused by its request key, one lens at a time](2026-11-15-lens-runs-reused-per-request.md), the paragraph "Where it holds"
Amends: [Credentials follow concrete task routes](2026-10-08-credentials-follow-concrete-task-routes.md), the sentence "Finished tasks need no unlock"

Status: for [issue #474](https://github.com/melian-agent/melian/issues/474), whose brief asks that every read-ahead unlock follow the rule, or say why one needs no change. The coordinator scoped the issue on 2026-11-15, in its session. The fixes and the reasons below are the builder's.

## Problem

A credential command cannot run inside a Pi Durable commit, so each step that may ask a model reads first, unlocks what the read calls for, and then commits. Another review in the same process can commit between the two. The amended decision made `runLenses` act only on what its read found, and left four other sites to this issue. Three of them broke the rule.

- Triage. A review read a failed decision task and planned to attach to it, so it unlocked nothing. A `--rerun` review then replaced the task with a live one, and the first review attached to that task with the decider's credentials never unlocked.
- The final verification, `startVerification`. A review read a finished verification task and planned to attach, so it unlocked nothing. Another review then replaced the index entry with a task for another version, and the first review's commit created a task of its own with every verifier route still locked.
- The walkthrough, `summarizeReview`. A review read that the attempts were spent, so it unlocked nothing. A `--rerun` then started a live task, or reset the attempts and failed once, and the first review attached to that task, or created one, with the light model still locked.

## Choice

The rule from the amended decision holds at every read-ahead unlock: a commit acts only on what its read found, and any other outcome writes nothing, after which the step unlocks every provider it could ask and commits again. Each site does this its own way.

| Site | What the read records | What the commit refuses |
| --- | --- | --- |
| `runLenses`, `review.ts` | the task it will attach to, or the lenses it will copy | any other task, or other copies, since [pull request #466](https://github.com/melian-agent/melian/pull/466) |
| Triage, `review.ts` | the decision task it will attach to without unlocking | attaching to any other task, and creating one |
| `startVerification`, `verification.ts` | the verification task it will attach to without unlocking | attaching to any other task, and creating one |
| `summarizeReview`, `summarize.ts` | that it will neither attach nor create, so it unlocked nothing | attaching to a task, and creating one |

Two sites need no change.

- Each wave's start, `startWave` in `verification.ts`. Its commit recomputes the fresh candidates and keeps only those its read found fresh and unlocked, and it never attaches to a task, so it cannot act on what its read did not see.
- The host's unlock before a resume, `ReviewHarness.resumedProviders`, which the CLI calls in `packages/cli/src/commands.ts` before any wait. It reads each live task's route from its stored input and checkpoint. A task's input never changes, and its checkpoint moves only while it runs, which starts at the first wait. One process owns a storage at a time, so what the read found is what resumes. A task this process creates later unlocks through its own site.

The evals' `liveModels`, in `packages/evals/src/credentials.ts`, unlocks every named credential before the first review and reads nothing first.

A commit that refuses gives the step a signal it cannot mistake for a result. Triage's returns `undefined`, which its commit never returns otherwise. The final verification's returns a private symbol, since `undefined` already means there is nothing to wait for. The walkthrough's refuses after it has counted a finished attempt, so it throws a private error, and Pi Durable stores none of a commit whose callback throws.

## What it costs

A refused commit costs one more commit and the credential commands the read had skipped. It happens only when another review commits between the read and the commit.

Those commands run even when the second commit attaches to a task that finished in the meantime, which the concrete-route decision said needs no unlock. That sentence now holds except after a refused commit. Reading again before the second commit would not help: another review can commit between that read and the commit too, so the step would refuse and read again with no bound. Unlocking every provider ends the loop at the second commit, and the credential store runs each command once per process.

## Tests

Each fix's test makes another review commit between the read and the commit, by wrapping the harness read the step makes, and expects the credential command for the providers the commit then asks. Each failed on the code before its fix with no credential command run.

- `packages/pipeline/test/read-ahead-unlock.test.ts`, for triage, beside a test that a review attaching to the decision it read unlocks nothing.
- `packages/pipeline/test/verification.test.ts`, "unlocks the candidates' routes when it read a task to attach to and another verification meanwhile replaced it".
- `packages/pipeline/test/summarize.test.ts`, the two tests that read the attempt cap while a `--rerun` starts a task or leaves an attempt free.
