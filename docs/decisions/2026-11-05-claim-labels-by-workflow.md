# A workflow swaps the claim labels

Amends: [The plan's work lives in GitHub issues](2026-10-26-plan-as-issues.md), who swaps the claim labels and whose claims count.

## Problem

A cloud builder cannot claim an issue alone. Claude's cloud sessions reach GitHub through the Claude GitHub App, and its label edits can be refused for want of Issues write. The app's owner sets those permissions, so the maintainer cannot grant them. The coordinator then swaps the labels by hand for every claim, as it did for [issue #262](https://github.com/melian-agent/melian/issues/262) and [issue #252](https://github.com/melian-agent/melian/issues/252). Every builder can already post a comment.

## Decision

A builder claims by commenting `Claim:`. The workflow `.github/workflows/claim.yml` runs on every new issue comment with a token holding `issues: write` alone. Whatever comment started it, a run reads the issue's whole timeline, in GitHub's order, and works out which status label the rules call for. A `status: ready` label opens the issue to claims. The first `Claim:` after it from a commenter with write, maintain or admin permission, read from the collaborator permission endpoint, calls for `status: in progress`. A writer's `Released:` after that calls for `status: ready` again. A hand removal of the label the rules call for leaves the issue to whoever removed it, until it is marked ready again. The run then makes the labels match, adding the label it wants before removing the other, and writes nothing when they already match. A builder whose token can edit labels may still swap them by hand.

A run reconciles rather than swaps because a one-off swap can be lost. Example: a remove that succeeds before an add that fails strands the issue with neither label. A newer comment's run can also replace a claim's pending run in the concurrency group, so the claim is never applied. Each later run repairs either, and adding first means a failure partway leaves both labels, which the next run reduces to one.

Only writers' claims count. The earlier rule made the earliest `Claim:` comment win, whoever wrote it, so anyone who can comment could hold an issue with one line. A non-writer's comment is data under the trust rules, so it cannot claim.

## Why

The swap needs a token the builder lacks, and a workflow in the repository has one. The rules it applies are the ones a builder already followed, so nothing else in the claim procedure changes. The job checks out nothing and runs one `actions/github-script` step, pinned by commit, whose script reads the comments from the API. No expression interpolates a comment into the script or a shell, so a comment's text is only ever data. The timeline is the authority for order: joining events and comments by their timestamps, which GitHub gives to the second, let a claim posted in the same second as the ready label count as after it. A concurrency group per issue runs the reconciliations on one issue in order.
