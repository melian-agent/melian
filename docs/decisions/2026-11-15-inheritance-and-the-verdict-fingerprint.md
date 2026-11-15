# An inheritance reaches the verdict's fingerprint as any dismissal does

Amends: [A dismissal carries to a restatement](2026-11-08-dismissal-carries-to-restatement.md), where a switch of an inherited dismissal's root is shown

Status: decided by the maintainer on 2026-11-15, in the coordinator's session, for [issue #334](https://github.com/melian-agent/melian/issues/334). The maintainer answered "Agree" to option 1 of [the analysis](https://github.com/melian-agent/melian/issues/334#issuecomment-6892684955), and [the ruling is recorded on the issue](https://github.com/melian-agent/melian/issues/334#issuecomment-6893460620). The fingerprint's code does not change. Codex's adversarial review on [pull request #471](https://github.com/melian-agent/melian/pull/471) showed that the first wording overstated where a switch of root shows, which the summary the maintainer ruled on repeated. The section below states the rule the code follows, and the coordinator told the maintainer of the correction. The maintainer accepted the amendment below on 2026-11-16, in the coordinator's session, answering "agree". The design lens then showed that GitHub's body limit can cut the new root from the ledger, and a test confirmed it. On 2026-11-16, in the coordinator's session, the maintainer chose to state the promise as it is, answering "agree", and left changing what gets cut to [issue #482](https://github.com/melian-agent/melian/issues/482).

It rests on [Dismissal publication](2026-10-04-dismissal-publication.md), which keeps who dismissed a finding, why and when out of the verdict's fingerprint, and on [A dismissal carries to a restatement](2026-11-08-dismissal-carries-to-restatement.md), which left this question to [issue #334](https://github.com/melian-agent/melian/issues/334). It amends the second where it says where an inheritance is shown, and changes nothing in the first.

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

- The ledger's stamp holds the projection, and the ledger lists each dismissal it attests with its root. So while the ledger fits GitHub's 65,536 characters, it is rewritten to name the new root, for a report merged under a live speaker too. Past that limit the ledger drops whole sections from its end, and its summary's list of attested dismissals is cut at a line. That list follows the verdict's order, by path, so a dismissal whose path sorts late can lose its root. When the cut ledger reads the same with either root, its projection does not change, and it is not rewritten.
- `dismissalVersion` in `packages/core/src/publication.ts` hashes `inheritedFrom`, so a finding with a thread of its own gets a reply naming the new root.
- The status description names roots only when no finding is still shown, as `Verdict.reviewStatus()` in `packages/core/src/adjudication.ts` writes it. It names as many as fit in the 93 characters its base suffix leaves, and counts the rest as "and K more". When the new root is among those named, the description changes, and publication sets the status again. While another finding is shown, or when the new root is among those counted, the description stays as it was.

So while another finding is shown, a finding with no thread of its own shows its new root in the ledger alone, and only while the ledger fits. Past the ledger's limit, and past the status's room for roots, only `melian publish`'s attestations and `melian findings --all` name it. Neither is bounded: `melian publish` prints the root of every dismissal its publication attested. Such a finding was posted in a review's body, or is a report merged under a live speaker. The last review's body keeps the old root. A person's second reason for such a finding gets no reply and no review either, by [the dismissal publication decision](2026-10-04-dismissal-publication.md), and this keeps the two alike.

**What it amends.** The restatement decision's Attribution clause says the terminal, the review body, the inline reply, the ledger and the status all show an inheritance. Its "What this gives up" says the inheritance is shown, naming the root, wherever the dismissal is. That holds when an inheritance first appears, because the finding moves into `dismissed` and the fingerprint changes, so a review posts. It does not hold for a later round at the same head that only switches the root. That round posts no review, so the last review's body keeps the old root. The status names the new root only when no other finding is shown and the root fits its line, the thread only when the finding has one, and the ledger only while its dismissals fit GitHub's 65,536 characters. Past either bound, only `melian publish`'s attestations and `melian findings --all` name it. "Wherever the dismissal is" also claims more than the code does when an inheritance first appears: a review body over GitHub's limit is cut from its end, so its list of attested dismissals can lose the root too. This amendment narrows that clause to the same bounds. [issue #482](https://github.com/melian-agent/melian/issues/482) holds changing what gets cut. Every other clause of that decision stands.

## Why

The alternative put the root in the fingerprint, so a switch would post a review of its own. That review would repeat findings the pull request already shows, to say what the ledger, and the reply or the status where they apply, already say. A person's changed reason posts no review, and a changed root is the same kind of change: who dismissed, not what is open. Nor would that review close the gap past GitHub's limit: a review body is cut the same way.

Tests in `packages/core/test/restatement.test.ts` and `packages/pipeline/test/publish.test.ts` pin both cases and the merged report's switch. Two more in the second file pin the bounds: a switched root among those the status counts leaves the status as it was, and a merged report's switched root past the ledger's limit is named only in `melian publish`'s attestations. The [progress-log entry](../progress-log/2026-11-15-issue-334-inheritance-fingerprint.md) records the mutations the first tests fail.
