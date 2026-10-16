# Prove the telemetry reader's branches

[Pull request #135](https://github.com/melian-agent/melian/pull/135), pass 4.

Direct reader tests now distinguish task outcomes, failed triage, untimed checks, selected check ownership, legacy parent selection, verification claim subjects, cursor queries, missing entries and exact terminal spacing. The storage fake answers the requested document, task, owner and cursor.

The pass applied and restored all 22 distinguishable telemetry mutations named in the cold round. Each made a test fail. Three fail by throwing at the mutated dereference, and the other 19 fail assertions. All 27 tests pass after restoration. The two remaining named telemetry mutations remove redundant guards on an undefined call-start time; numeric comparisons with undefined still yield false. Their reasons are in the local pass report.
