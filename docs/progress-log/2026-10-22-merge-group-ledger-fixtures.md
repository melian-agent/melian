# 2026-10-22: ledger fixtures follow the reviewed-base suffix

The whole gate on [pull request #168](https://github.com/melian-agent/melian/pull/168) found two ledger fixture failures after the suffix changed. The writer-trust assertion still expected the old description. The abandoned-round fixture's API refusal made its new description exceed 140 characters.

The assertion now includes the reviewed base. The fixture uses the fake's short refusal message, preserving its error-status and ledger-link checks. All 64 ledger tests pass after those changes. The original gate log records both failing cases; the builder reruns the whole gate after the fixes.
