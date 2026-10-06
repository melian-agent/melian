# Count verdict reports against the verifier budget

[Pull request #80](https://github.com/melian-agent/melian/pull/80), tenth Melian round.

The verifier budget tests exhausted the limit with reads before reporting.
Removing report_verdict from the counted slots still passed both tests.

The new regression gives the judge one tool call. It reports a confirmed verdict,
then asks to read a file. The report remains recorded. The read returns
"[not run]" with a handoff, the candidate ends with one counted call, and the
conversation makes no further model request.

Removing report_verdict from the counter fails the regression: the candidate
finishes done instead of ending at its budget. Restoring the counter passes.
Production behaviour and architecture decisions are unchanged.
