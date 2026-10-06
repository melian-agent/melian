# Exact declaration matching

Confirmed fifth-round finding 260ae70ff8933be6 for [pull request #89](https://github.com/melian-agent/melian/pull/89).
A top-level helper borrowed a same-line nested helper's call through suffix matching.
Match the full directory-prefixed declaration name, file and start line.
Bump the coverage matcher identity so automatic lookup rejects old measurements.

The regression fails on the old matcher for facts, impact and combined coverage: it credits both calls instead of one.
The fixed coverage, cache, compiler and core graph suites pass 57 tests.
