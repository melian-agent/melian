# Quiet an all-advisory review

For [issue #266](https://github.com/melian-agent/melian/issues/266), a follow-up to [pull request #217](https://github.com/melian-agent/melian/pull/217), and not a numbered plan step. [The decision](../decisions/2026-11-05-quiet-advisory-reviews.md) records the published shape.

- `enola/god-class` is reported only when the change adds a line inside the result's region. Round 1 of [pull request #215](https://github.com/melian-agent/melian/pull/215) flagged `quoteUntrusted` for its 14 dependents when the change only called it. The report's notes count what was left out.
- The `overlong-sentence` guardrail says "45 or more words with no full stop; find the seam, as AGENTS.md asks" instead of about 40 words of AGENTS.md. Its golden copies the root rule, so its policy and scripted output changed with it.
- A review of advisories alone opens "No blocking findings, N advisories", with "M carried from earlier" when earlier revisions posted some.
- The verifier's tally and the `melian/review` line fold under "Verification and status".
- An advisory an earlier revision posted is counted, not listed again. The publish task passes `postedEarlier` from the pending round, so no stored shape changes.
- A posted comment's footer and an advisory's body line drop `Status`.

Each change started from a test that failed on `main` for the reported reason.
