# An Actions round finds the head's pusher in the repository's activity

Status: built in [pull request #299](https://github.com/melian-agent/melian/pull/299), at the coordinator's direction.

Amends: [Actions rounds run only the default branch's code with the logins](2026-11-06-actions-rounds-run-default-branch-code.md), the paragraph on a head no push event names.

## Problem

The gate trusts a head only when the identity that pushed that exact commit is a writer, and it read that identity from GitHub's events feed. The feed keeps only the latest 300 events, which this repository fills in about a day and a half, and lags by hours. Example: the first real round, [run 42355678065](https://github.com/melian-agent/melian/actions/runs/42355678065), refused head `3cd11dcc` of [pull request #299](https://github.com/melian-agent/melian/pull/299) three minutes after its push. The newest push in the feed was from 02:33 UTC, six hours earlier. Nearly every round would have been refused.

## Decision

The gate reads `GET /repos/{owner}/{repo}/activity` for the head's branch, every page, and takes the newest `push`, `force_push` or `branch_creation` entry whose `after` is exactly the head on exactly that ref. That entry's actor must hold write, maintain or admin permission. The activity API records each entry when it happens, so a round started straight after a push finds it.

It still fails closed. A head no such entry names is refused, and so is an entry with no actor, an unreadable line, or a failed read. A merge, a merge-queue merge, or a branch deletion never names the pusher.

## What this gives up

The cost the amended decision accepted, a round refused minutes after a push, is gone. The newest matching entry decides, as the newest push event did. If a bot pushed a commit and a writer later force-pushed the same commit back, the writer's entry is the newest and the round runs. That matches what the events feed allowed, and it is left as it was.
