# Stored check evidence

Confirmed Claude L9 for [pull request #89](https://github.com/melian-agent/melian/pull/89). StoredCheckRecord now declares snapshots and coverage. Verdict serialisation copies snapshot arrays. Its additive migration preserves evidence and leaves legacy records absent. Round-trip tests cover both shapes. Receipt timestamps remain lineage by the existing decision.
