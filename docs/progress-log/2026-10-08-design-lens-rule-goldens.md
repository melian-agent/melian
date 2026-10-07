# Four owed design rules have source-based goldens and clean twins

Trust-by-label and bound-on-wrong-measure use findings A2 and A3 from [pull request #85](https://github.com/melian-agent/melian/pull/85). Resumed-identity uses A1 from [pull request #86](https://github.com/melian-agent/melian/pull/86). Single-slot-overwrite uses A2 from [pull request #89](https://github.com/melian-agent/melian/pull/89), whose record is in [pull request #90](https://github.com/melian-agent/melian/pull/90).

The terminology-change golden covers criterion-selection-bias. Capability-by-class remains in the golden BACKLOG: the source decision names review threads but no source finding. No comparison record changed.

All eighteen design goldens use the fake model in the gate and carry the full tier. Runtime tests demonstrate each new seeded defect and exercise each clean twin. The bound tests cover 1024 bytes and 1025 bytes. The mutation inventory lives in tmp/design-lens-followup-report.md. Live judgement remains unmeasured until the three live passes finish.
