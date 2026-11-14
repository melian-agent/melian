# State branch guidelines

The state-git package is being rebuilt as the git adapter of core's `RecordStore`, which keeps the shared record on the repository's `melian/state` branch. Rule 12 of [the shared record decision](../decisions/2026-11-13-shared-record-behind-a-store-port.md) sets out what it keeps from the state branch and what goes: the storage lease, the sealing, the copy locks, the clone ID and the set-aside copies. [Issue #393](https://github.com/melian-agent/melian/issues/393) builds it.
