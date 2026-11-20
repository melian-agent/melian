# Issue #605: a guardrails record fits the store

[Issue #605](https://github.com/melian-agent/melian/issues/605): a head that changes many workspace manifests wrote a guardrails check record larger than the git store takes, so the store refused the round's records.

- Core defines the record limit once, `recordLimit`, 4 MiB. The git store's tree reader, the relay's per-file bound and every store's `add` read it. The relay's batch bound is twice it, 8 MiB, by the maintainer's ruling of 2026-11-20.
- Every store, memory, directory and git, refuses a record past the limit with `invalidRecord` through `SharedRecord.storable()`, measuring the whole batch before it writes. The conformance suite tests a record at the limit and one a byte past it.
- `SightingBudget.checkRecord` gives a check record's sightings the limit less a 4 KiB envelope allowance. The guardrails check fits its joined findings to it: in ID order, a finding keeps its detail while the full findings so far and every later one abridged fit, and each later one is `Finding.abridged`, with a fixed note naming how many files lost their detail. IDs, severities and resolutions are unchanged, so the blocking set is too.
- A record that cannot fit even with every finding abridged is left for the issue's pending ruling.

Tests: `packages/core/test/sighting-budget.test.ts` for the bound, a byte past it, the cut and determinism; the new conformance case in `packages/core/src/testing.ts`; the relay bounds in `packages/pipeline/test/record-relay.test.ts`; and `packages/cli/test/guardrails-record-budget.test.ts`, which runs the guardrails check over 1,500 changed workspace manifests and adds the trimmed record to a git store whole.
