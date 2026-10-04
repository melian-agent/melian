# trust-boundary-secret-env

Seeded from finding A6 of the [comparison record](../../comparisons/2026-10-03-pr-18.md) for [pull request #18](https://github.com/melian-agent/melian/pull/18): static tools inherited the whole process environment, secrets included, while running the head's configuration. Recast as a deletion: the record's static tools inherited the whole environment from the start, and here the head deletes the `env` that kept the linter to `PATH` and `HOME`.
