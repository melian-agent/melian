# Working in packages/state-git

@../../docs/guidelines/state-git.md

## Rules

- The package is being rebuilt as the git adapter of core's `RecordStore`, by [issue #393](https://github.com/melian-agent/melian/issues/393). The state branch's storage lease, sealing, copy locks, clone ID and set-aside copies are gone, by rule 12 of [the shared record decision](../../docs/decisions/2026-11-13-shared-record-behind-a-store-port.md).
- Run git through core's `git`, which removes the repository-local variables a hook sets.
