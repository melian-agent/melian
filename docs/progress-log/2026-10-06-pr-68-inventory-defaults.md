# Comparison default arguments

For [pull request #68](https://github.com/melian-agent/melian/pull/68), six default-context mutations failed existing assertions. A default error cause and the close context had no failing assertion. Two memory-only regressions pin absent and supplied causes, and default and explicit close-context forwarding. Both surviving operators fail these tests; all 21 pipeline comparison tests pass after restoration. No design decision changed.
