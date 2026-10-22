# 2026-10-22: an abandoned review replaces the head's success

Codex's adversarial review of [pull request #168](https://github.com/melian-agent/melian/pull/168) found that an abandoned review could leave a `success` status standing. Publication posts the verdict's status before the review. After the third refusal, the abandonment status carried GitHub's message, and with the reviewed-base suffix the fake API's own refusal passed the 140-character limit. The provider refused the status, publication swallowed that refusal, and `melian status merge-group` accepted a head whose review was never posted. The earlier fix pass had shortened the fixture's refusal instead.

The abandonment status now has a fixed description, `Melian could not post its review; see the publish record`, so it always fits beside the suffix. The abandoned round keeps the provider's message. A status Melian cannot set is named in the publish error rather than dropped. The fixtures use the fake's realistic refusal again.

`packages/cli/test/merge-group-abandoned.test.ts` publishes a passing verdict, has the review refused three times, and runs the merge-group command on the head. It failed on c75453bb with the `success` status still latest, and passes after the fix.
