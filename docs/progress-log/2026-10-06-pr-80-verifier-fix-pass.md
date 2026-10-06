# Verifier first-round fixes

[Pull request #80](https://github.com/melian-agent/melian/pull/80). Merged decider-triage at 2eb6e0f, retaining verification, adjudication and decision recovery, shared fake models and the hand-off test.

A rerun can now refute a claim the failed task confirmed. Task replacement clears previous judgements atomically with the index change. The strength rule still holds within one task, including crash replay.

Explicit verifier routes without credentials now fail with the plan’s reason and lineage. Only an unrouted tier uses lens routes. Core tests pin the doctor warning and fallback, and a fake-model review checks refusal before a verifier request.

Refutation tests now reject missing, empty and unreadable evidence. The missing-evidence case fails when both non-empty guards are removed.

Verifier execution errors now quote diagnostics inside findings boundaries and render control characters visibly. The regression commits an instruction-like filename with a newline, cites a line past EOF, and inspects the error the model receives.

A failed-task regression keeps candidates unchanged. A repeat review attaches without requests; rerun replaces only the verifier task and records a fresh judgement. Removing the retry-on-rerun condition makes the test fail.

The Node 24 gate passed with MELIAN_STATE_DIR unset: 51 files and 1,306 tests passed; one test was skipped. No test timed out. Biome, type checking, dependency checks and audit passed.
