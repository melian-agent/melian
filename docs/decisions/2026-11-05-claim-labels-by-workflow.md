# A workflow swaps the claim labels

Amends: [The plan's work lives in GitHub issues](2026-10-26-plan-as-issues.md), who swaps the claim labels and whose claims count.

## Problem

A cloud builder cannot claim an issue alone. Claude's cloud sessions reach GitHub through the Claude GitHub App, and its label edits can be refused for want of Issues write. The app's owner sets those permissions, so the maintainer cannot grant them. The coordinator then swaps the labels by hand for every claim, as it did for [issue #262](https://github.com/melian-agent/melian/issues/262) and [issue #252](https://github.com/melian-agent/melian/issues/252). Every builder can already post a comment.

## Decision

A builder claims by commenting `Claim:`. The workflow `.github/workflows/claim.yml` runs on every new issue comment with a token holding `issues: write` alone. Comments decide. Whatever comment started it, a run reads the issue's whole timeline, in GitHub's order, and takes the state from three kinds of event:

- a `status: ready` label added by a writer opens the issue to claims;
- after it, the first `Claim:` from a writer calls for `status: in progress`;
- after that, a writer's `Released:` opens the issue again, and the next writer's `Claim:` takes it.

A writer is a commenter or labeller with write, maintain or admin permission, read from the collaborator permission endpoint. The run ignores every removal, every `status: in progress` label, and every label event by its own token. It then makes the labels match, adding the label it wants before removing the other, and writes nothing when they already match. A hand edit of a status label is undone by the next comment's run, so a builder only comments, and a writer takes an issue back by commenting `Released:`.

Comments decide because every rule that also read label edits lost to an interleaving. Example: a claim's run writes its labels after a release was posted, and a rule that read the run's own removal of `status: ready` as a hand edit then dropped the release. Round 1 of [pull request #274](https://github.com/melian-agent/melian/pull/274) found two such orderings and round 2 found four more, so the maintainer ruled on the class: no label edit but a writer's `status: ready` moves the state.

A run reconciles rather than swaps because a one-off swap can be lost. A remove that succeeds before an add that fails strands the issue with neither label. A newer comment's run can also replace a claim's pending run in the concurrency group, so the claim is never applied. Each later run repairs either, and adding first means a failure partway leaves both labels, which the next run reduces to one.

Only writers' comments and ready labels count. The earlier rule made the earliest `Claim:` comment win, whoever wrote it, so anyone who can comment could hold an issue with one line. A user with triage permission can add labels but is not a writer, so their `status: ready` opens nothing. A non-writer's comment or label is data under the trust rules.

## Why

The swap needs a token the builder lacks, and a workflow in the repository has one. The rules it applies are the ones a builder already followed, so nothing else in the claim procedure changes. The job checks out nothing and runs one `actions/github-script` step, pinned by commit, whose script reads the comments from the API. No expression interpolates a comment into the script or a shell, so a comment's text is only ever data. The timeline is the authority for order: joining events and comments by their timestamps, which GitHub gives to the second, let a claim posted in the same second as the ready label count as after it. A concurrency group per issue runs the reconciliations on one issue in order.
