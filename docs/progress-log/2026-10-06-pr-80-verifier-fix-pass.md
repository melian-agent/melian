# Verifier first-round fixes

[Pull request #80](https://github.com/melian-agent/melian/pull/80). Merged decider-triage at 2eb6e0f, retaining verification, adjudication and decision recovery, shared fake models and the hand-off test.

A rerun can now refute a claim the failed task confirmed. Task replacement clears previous judgements atomically with the index change. The strength rule still holds within one task, including crash replay.

Explicit verifier routes without credentials now fail with the plan’s reason and lineage. Only an unrouted tier uses lens routes. Core tests pin the doctor warning and fallback, and a fake-model review checks refusal before a verifier request.
