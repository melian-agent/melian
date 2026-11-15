# An inheritance reaches the verdict's fingerprint as any dismissal does

Status: decided by the maintainer on 2026-11-15, in the coordinator's session, for [issue #334](https://github.com/melian-agent/melian/issues/334). The maintainer answered "Agree" to option 1 of [the analysis](https://github.com/melian-agent/melian/issues/334#issuecomment-6892684955), and [the ruling is recorded on the issue](https://github.com/melian-agent/melian/issues/334#issuecomment-6893460620). The fingerprint's code does not change. Codex's adversarial review on [pull request #471](https://github.com/melian-agent/melian/pull/471) showed that the first wording overstated where a switch of root shows, which the summary the maintainer ruled on repeated. The section below states the rule the code follows, and the coordinator told the maintainer of the correction.

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

A switch of root still reaches the pull request, though not every surface names it:

- The ledger's stamp holds the projection, and the ledger lists each dismissal it attests with its root, so the ledger is rewritten to name the new root. That holds for every dismissed finding, a report merged under a live speaker included.
- `dismissalVersion` in `packages/core/src/publication.ts` hashes `inheritedFrom`, so a finding with a thread of its own gets a reply naming the new root.
- The status description names roots only when no finding is still shown, as `Verdict.reviewStatus()` in `packages/core/src/adjudication.ts` writes it. Then publication sets the status again, since its description changed. While another finding is shown, the description counts findings and names no root, so it stays as it was.

So while another finding is shown, a finding with no thread of its own shows its new root in the ledger alone. Such a finding was posted in a review's body, or is a report merged under a live speaker. The last review's body keeps the old root. A person's second reason for such a finding gets no reply and no review either, by [the dismissal publication decision](2026-10-04-dismissal-publication.md), and this keeps the two alike.

## Why

The alternative put the root in the fingerprint, so a switch would post a review of its own. That review would repeat findings the pull request already shows, to say what the reply, the status and the ledger already say. A person's changed reason posts no review, and a changed root is the same kind of change: who dismissed, not what is open.

Tests in `packages/core/test/restatement.test.ts` and `packages/pipeline/test/publish.test.ts` pin both cases and the merged report's switch, and the [progress-log entry](../progress-log/2026-11-15-issue-334-inheritance-fingerprint.md) records the mutations each one fails.
