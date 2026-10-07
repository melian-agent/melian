# design-fail-open-default

Seeded from finding A2 of the [comparison record](../../comparisons/2026-10-06-pr-86.md) for [pull request #86](https://github.com/melian-agent/melian/pull/86): an omitted optional writer-trust argument defaulted to trusted and let a caller bypass committed policy. The record marks the miss `owned-missed` under `trust-boundary`; no one is hostile here, a caller only leaves an argument out, so the design lens owns it. The base requires the answer; the head makes it optional with a default of trusted, and a new caller omits it.
