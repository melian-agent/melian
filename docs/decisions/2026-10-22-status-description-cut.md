# `melian publish` cuts a status description's prose and keeps the reviewed-base suffix whole

Amends: [the merge-group decision](2026-10-22-melian-review-on-merge-groups.md), the clause that `melian publish` refuses to write a description it would have to cut, and test 17.

Choice: `melian publish` never refuses a status description for length. `setStatus` cuts the prose to fit, ending it with "…", so the prose plus `; base <40 lowercase hex>` is at most 140 characters, and appends the suffix exactly. The merge-group command accepts exactly one `; base `, the one at the end, so a doubled suffix fails closed.

Why: a refused status leaves an earlier `success` on the head, and `melian status merge-group` accepts it. Two reviews of [pull request #168](https://github.com/melian-agent/melian/pull/168) found this. Codex's adversarial review found it through the abandonment message, which carried GitHub's refusal. The review of record found it through the not-reviewed description, which lists every check that did not run: 112 characters became 159 with the suffix, `setStatus` refused it, and publish stopped before writing `error`. The suffix is never cut, so no cut can leave a prefix git accepts as a SHA.

Test 17 now reads: a prose prefix of 93 characters posts whole at 140 with the suffix, and one of 94 is cut to 92 characters and "…".

Residual: if GitHub refuses the abandonment's `error` status as well as the review, the earlier `success` can remain; publish names the refused status in its error and exits non-zero.
