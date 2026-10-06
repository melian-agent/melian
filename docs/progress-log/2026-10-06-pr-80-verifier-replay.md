# Verifier fourth-round replay regression

[Pull request #80](https://github.com/melian-agent/melian/pull/80). Confirmed a coverage gap: weaker-report tests returned at the strength guard and never tested the identical-report guard.

Added replay cases for confirmed, plausible and refuted reports. Each commits a first judgement, checks its version bump and stored record, then replays an identical report in a separate commit. The stored findings and revision’s findings version stay unchanged.

Removing only the equality guard makes all three new cases fail on the extra version bump. Restored the guard; the findings suite passes. Production behaviour is unchanged.

The Node 24 gate passed with MELIAN_STATE_DIR unset: 51 test files and 1,319 tests passed; one test was skipped. No test timed out. Biome, type checking, dependency checks and audit passed.
