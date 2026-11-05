# A review of advisories reads as one

Status: accepted by the maintainer, 2026-11-05, in [issue #266](https://github.com/melian-agent/melian/issues/266).

Amends: [High signal, low noise](2026-10-25-high-signal-low-noise.md), rule 4's open status line.
Amends: [Findings read in one register](2026-10-24-finding-register.md), the footer's lifecycle status on a posted finding and rows 1, 17, 20 and 24 of "What every renderer keeps".
Amends: [Advisories belong in the review body](2026-10-22-advisories-in-review-body.md), which advisories a later revision lists.

## Problem

A published review that held only advisories still read as work to do, and it posted the same advisories again on every revision.

Example: [the final review](https://github.com/melian-agent/melian/pull/215#pullrequestreview-5766213215) on [pull request #215](https://github.com/melian-agent/melian/pull/215) had one finding worth acting on. Above it, the header said "3 findings need attention: 3 advisory", though an advisory asks for no action. It then gave a verification tally and a `melian/review` line the status check already showed. It said "2 of them were posted on an earlier revision" and listed both again in full. Each line read `New in this change` and `Status new`, which a reader took for one claim made twice.

## Decision

1. A review whose counted findings are all advisories opens "No blocking findings, N advisories". When earlier revisions posted some, it adds "M carried from earlier". A review with a block or an acknowledgement keeps "N findings need attention" and its still-open sentence.
2. The verifier's tally and the `melian/review` state and description fold under one `<details>` block, "Verification and status", after the open sections. The status check shows both, so they are for a reader who wants to dig in. The fold's summary is a noun phrase, not a count: it holds two facts, not N of one. The dismissal instruction stays open, since it asks the reader to act.
3. An advisory is listed once. A later revision counts it in the header and lists only the advisories it posts now. The publish task passes the pending round's `open` as `ReviewDraft.open`; an advisory in it that the review does not post was posted earlier. A renderer given none, such as the ledger's summary, lists every advisory as before.
4. A posted finding's footer and an advisory's body line drop `Status`. A comment is posted once, so its status always read `new`. The terminal keeps the lifecycle status in its footer.

No stored shape changes. `open` is read at post time from the pending round, and a round recovered by its markers is not rendered again.

## Why

An advisory needs no action, so a header that says it does trains readers to skim past the header. The same advisory listed on every revision breaks rule 1 of the high-signal decision across a pull request's reviews: a reader who read it once reads it again each push. Counting it keeps the fact and drops the repeat.
