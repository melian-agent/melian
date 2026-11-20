# Issue #481: two record errors the review of record found at 9a9ee7b91

For [issue #481](https://github.com/melian-agent/melian/issues/481), on [pull request #575](https://github.com/melian-agent/melian/pull/575).

The review of record at `9a9ee7b91` found two records that say more than happened.

- [The multi-host entry](2026-11-20-issue-481-multi-host-and-merge.md) says the frontier inventory's rows outside `recorded-round.ts` ran at `ad499a63a`. The `review.ts:3312` rows whose named tests are "fails the review on an error of no dismissal", "fails the review on a dismissal error that is no reason to leave the record unshared" and "names the dismissal unshared, and finishes the review" could not have: those tests first exist at `0d2384bc6`. Those rows ran at `0d2384bc6` or later. The review of record reran its sample of the inventory, each claim at the commit that first holds its named test, and every killed claim held.
- The pull request's description said a commit the checkout lacks leaves the finding live. The reader refuses the whole round instead, as the frontier decision says, which is stricter. The description now says so.

The review's two findings on how the reader builds the hunks a round is tested against have failing tests in `recorded-round.test.ts`. Their fix waits on the maintainer, so this entry records neither.
