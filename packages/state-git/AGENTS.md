# Working in packages/state-git

@../../docs/guidelines/state-git.md

## Rules

- The package imports core alone. It never imports Pi Durable or `@melian-agent/pipeline`.
- Run git through `RecordRepository.run`, which runs core's `git` with the repository's configuration checked and the overrides passed.
