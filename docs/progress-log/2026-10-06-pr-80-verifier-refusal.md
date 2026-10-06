# Verifier fourth-round refusal fix

[Pull request #80](https://github.com/melian-agent/melian/pull/80). Confirmed that refusing verification kept the old owner and judgements. Before the fix, six fake-model cases retained a blocker or hid a refuted finding.

The refusal now detaches verification and clears judgements in the transaction that records the failed check in a new adjudication task. Its input uses the findings version after clearing. The transaction retires old adjudication ownership; the sweep aborts retired tasks before waiting.

Regressions cover policy refusal, an uncredentialed explicit plan and a library route without credentials, each after confirmation and refutation. They retain the lens task, make no verifier request, remove verification ownership and judgements, and store all findings at advisory with not-reviewed status. The verifier suite and type checking pass.
