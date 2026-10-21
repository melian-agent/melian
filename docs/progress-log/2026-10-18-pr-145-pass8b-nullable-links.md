[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 8b, accepts null and absent values for both optional publication-comment links. A null reply link previously rejected the complete listing; an absent parent review link did too. Regression tests first reproduced both failures, then recovered the review, root and reply. Present links still require positive safe integers. Six hand mutations failed the acceptance and malformed-link tests. The [GitHub guideline](../guidelines/github.md#markers) records the common rule.

The pass-8b gate had 4 sandbox failures, 4,829 passes and 53 skips. All four failures need `ps`, which the Codex seatbelt denies. The coordinator confirmed this limitation in pass 8c; the host must run the full gate.

## Hand mutation inventory

Each mutation ran alone against `publication record validation` in provider.test.ts, exited 1 and was restored before the next run. The acceptance tests failed before the fix (2 failures, 2 passes); all 97 provider tests passed after it. Logs live under `tmp/orphan-thread-pass8b-*.log`.

| Mutation | Failing test |
|---|---|
| Remove the parent-review nullish allowance | Null and undefined review-link acceptance |
| Allow only null for the parent-review link | Undefined review-link acceptance |
| Remove parent-review link validation | String, zero, negative, fractional and unsafe review-link rejection |
| Remove the reply-link nullish allowance | Null and undefined root reply-link recovery |
| Allow only undefined for the reply link | Null root reply-link recovery |
| Remove reply-link validation | String, zero, negative, fractional and unsafe reply-link rejection |
