# A workflow swaps the claim labels

Amends: [The plan's work lives in GitHub issues](2026-10-26-plan-as-issues.md), who swaps the claim labels and whose claims count.

## Problem

A cloud builder cannot claim an issue alone. Claude's cloud sessions reach GitHub through the Claude GitHub App, and its label edits can be refused for want of Issues write. The app's owner sets those permissions, so the maintainer cannot grant them. The coordinator then swaps the labels by hand for every claim, as it did for [issue #262](https://github.com/melian-agent/melian/issues/262) and [issue #252](https://github.com/melian-agent/melian/issues/252). Every builder can already post a comment.

## Decision

A builder claims by commenting `Claim:`. The workflow `.github/workflows/claim.yml` runs on each new issue comment with a token holding `issues: write` alone. It swaps `status: ready` for `status: in progress` when three things hold: the commenter has write, maintain or admin permission, read from the collaborator permission endpoint; the issue carries `status: ready`; and the comment is the earliest writer's `Claim:` since the last event that labelled the issue `status: ready`. Otherwise it changes nothing. A writer's `Released:` comment swaps `status: in progress` back to `status: ready`. A builder whose token can edit labels may still swap them by hand.

Only writers' claims count. The earlier rule made the earliest `Claim:` comment win, whoever wrote it, so anyone who can comment could hold an issue with one line. A non-writer's comment is data under the trust rules, so it cannot claim.

## Why

The swap needs a token the builder lacks, and a workflow in the repository has one. The rules it applies are the ones a builder already followed, so nothing else in the claim procedure changes. The job checks out nothing and runs one `actions/github-script` step, pinned by commit, whose script reads the comment from the event payload. No expression interpolates the comment into the script or a shell, so the comment's text is only ever data. A concurrency group per issue runs the claims on one issue in order, so two claims never both see the issue ready.
