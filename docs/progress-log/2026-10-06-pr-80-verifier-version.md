# Verifier version replacement

[Pull request #80](https://github.com/melian-agent/melian/pull/80), eighth Melian round.

All 42 verifier tests passed after removing the verifier version from the
attachment key. An upgraded verifier could therefore reuse a completed task and
keep its old refutation without another judge request.

The new regression completes a v1 verification with a refutation. It changes only
the verifier version to v2, without rerun. It asserts a new task, no prior
judgement before that task runs, fresh judge requests and a v2 confirmation.
Removing the version from the key fails the new-task assertion. Restoring it
passes the test. Production code and architecture decisions are unchanged.
