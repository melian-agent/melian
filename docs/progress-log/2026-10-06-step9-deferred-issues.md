# Step 9: deferred issues

`reviewChangeset` now runs deterministic checks through a review harness opened with a checkout. It keeps the loaded configuration for check identity before the plan changes model routes. Supplied records opt out, and hosts without that capability keep the existing manifest behaviour. This closes the implementation of [issue #26](https://github.com/melian-agent/melian/issues/26).

`Standards` now loads nested chains with shared reads, stable per-lens unions, and a 1 MiB cap that names whole sections omitted. Each lens now receives its own chains, and worktree sections have untrusted boundaries. Version 6 of the verdict document records per-lens paths beside their union and preserves older records with paths absent. Doctor and the two callers for [issue #46](https://github.com/melian-agent/melian/issues/46) are next. [Issue #22](https://github.com/melian-agent/melian/issues/22) was closed by [pull request #60](https://github.com/melian-agent/melian/pull/60).
