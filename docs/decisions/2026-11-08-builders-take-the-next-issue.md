# Builders take the next issue themselves

Amends: [docs/decisions/2026-10-26-plan-as-issues.md](2026-10-26-plan-as-issues.md), who starts an issue

The maintainer ruled on 2026-11-08 that a builder takes the next `status: ready` issue whose blockers are all closed once its pull request reaches the merge queue, without waiting for the coordinator to assign one.

## Why

A builder that finished sat idle until the coordinator noticed and briefed it. The loop-time analysis of eight pull requests, 5 to 7 November, put builder pickup lag at 25 of 124.5 elapsed hours. One session was idle for 15.7 of them. The builder on [issue #312](https://github.com/melian-agent/melian/issues/312) took [issue #323](https://github.com/melian-agent/melian/issues/323) on its own as soon as [pull request #321](https://github.com/melian-agent/melian/pull/321) was queued, and had a draft open within the hour.

## The rule

- A builder starts when its pull request is in the merge queue, not when it merges. A queue ejection sends it back to that pull request first.
- It skips an issue its session cannot carry out, such as one that needs the host's Melian store, live model credentials, or a machine it is not on. A cloud session cannot run `melian compare` against the host's store, so a comparison record issue waits for the host.
- The claim rule decides between two builders that choose the same issue: the earliest writer's `Claim:` wins, and the other yields.
- The coordinator may still ask a session to take an issue. That session claims it as usual, and the claim rule still decides.
