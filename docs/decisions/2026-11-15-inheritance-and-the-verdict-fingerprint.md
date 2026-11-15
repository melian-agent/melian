# An inheritance reaches the verdict's fingerprint as any dismissal does

Status: decided by the maintainer on 2026-11-15, in the coordinator's session, for [issue #334](https://github.com/melian-agent/melian/issues/334). The maintainer answered "Agree" to option 1 of [the analysis](https://github.com/melian-agent/melian/issues/334#issuecomment-6892684955), and [the ruling is recorded on the issue](https://github.com/melian-agent/melian/issues/334#issuecomment-6893460620). The fingerprint's code does not change.

It rests on [Dismissal publication](2026-10-04-dismissal-publication.md), which keeps who dismissed a finding, why and when out of the verdict's fingerprint, and on [A dismissal carries to a restatement](2026-11-08-dismissal-carries-to-restatement.md), which left this question to issue #334. It changes neither, so it declares no amendment.

## Problem

`Verdict.fingerprint()` decides whether publication posts a new review at a head. [Issue #315](https://github.com/melian-agent/melian/issues/315) and [pull request #344](https://github.com/melian-agent/melian/pull/344) let a restatement inherit a human dismissal, stored with `melian` as its dismisser and `inheritedFrom` naming its root. Nobody had said whether an inheritance should change the fingerprint, or whether a switch of root should.

Two cases matter. A round at one head inherits a dismissal for one of two live findings: should it post a review? A later round at the same head finds a newer root for the same restatement, which stays dismissed: should it post again?

## Decision

The fingerprint stays as built. An inheritance changes it through the same fields any dismissal changes:

- The inherited finding moves out of its resolution group into the verdict's `dismissed` list.
- The verdict's `status` can flip, as when the last live acknowledgement inherits.
- A merged report's `alsoReportedAs[].dismissed` flag changes.

The root lives inside `dismissal`, beside the reason, the dismisser and the time, and stays out, as they do. So the first case posts a review and recounts the status. The second posts no review.

A switch of root still reaches the pull request without one:

- `dismissalVersion` in `packages/core/src/publication.ts` hashes `inheritedFrom`, so the finding's thread gets a reply naming the new root.
- The status description names the new root, and publication sets the status again when its description changes.
- The ledger's stamp holds the projection, so the ledger is rewritten.

Only a finding with no thread, posted in a review's body, keeps the old root in the last review. A person's second reason for such a finding is not posted either, by the dismissal publication decision, and this keeps the two alike.

## Why

The alternative put the root in the fingerprint, so a switch would post a review of its own. That review would repeat findings the pull request already shows, to say what the reply, the status and the ledger already say. A person's changed reason posts no review, and a changed root is the same kind of change: who dismissed, not what is open.

Tests in `packages/core/test/restatement.test.ts` and `packages/pipeline/test/publish.test.ts` pin both cases, and the [progress-log entry](../progress-log/2026-11-15-issue-334-inheritance-fingerprint.md) records the mutations each one fails.
