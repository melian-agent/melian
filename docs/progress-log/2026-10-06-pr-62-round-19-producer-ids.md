# Versionless producer ID filters

The nineteenth Melian round on [pull request #62](https://github.com/melian-agent/melian/pull/62) found that a versionless producer bypassed its ID filter.
`readFindings` now matches it by check name and applies its IDs across every version.
An exact producer can still admit its own sightings beside a restricted versionless producer.

The regression stores versionless and versioned sightings of one check.
It failed before the fix because each restricted read returned both findings.
The findings suite passes after the fix.
