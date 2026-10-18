# Recovered roots belong to their review

Codex's adversarial review of [pull request #155](https://github.com/melian-agent/melian/pull/155) found that `findPublished` took the first signed root per finding at a head, from any review.
One head can hold roots for a finding in two reviews: head H posts F in thread 1002, F resolves at H with its edit failing, a human resolves 1002, and F returns at H in thread 1009.
A crash after the 1009 review posted made recovery record 1002, so 1009 was never resolved.

The coordinator ruled that GitHub's `pull_request_review_id` decides: a root counts only when it names the recovered review. No author or identity logic changed; [issue #154](https://github.com/melian-agent/melian/issues/154) still holds that.

The regression test in `packages/pipeline/test/publish.test.ts` failed on `7ceeee75` with `expected '1002' to be '1009'` and passes after the fix.
Five tests that recovered roots with no review now supply the review the roots belong to; their asserted threads and replies are unchanged.
Hand mutations: dropping the review match fails the regression test; dropping the head match fails a new test that keeps another head's root out of the recovered review.
