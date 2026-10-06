# Schema shape mutation inventory

For [pull request #68](https://github.com/melian-agent/melian/pull/68), audited every value-type, literal and optional-field constraint in the comparison schemas. Eleven of 88 additional operators passed existing tests. Eight direct schema tests now fail them: matches of both kinds, optional author fields, non-empty unmatches, both resolved-file states and posting metadata, all Codex severities and a next step. The restored schema, core comparison and thread suites pass all 177 tests. No design decision changed.
