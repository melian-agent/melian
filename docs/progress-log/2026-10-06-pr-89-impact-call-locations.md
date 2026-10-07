# Impact call locations

Confirmed sixth-round finding dccadc07e6016f56 for [pull request #89](https://github.com/melian-agent/melian/pull/89).
Removing both caller-location checks leaves 40 existing compiler and coverage tests passing.
Impact-only fixtures keep names and call edges valid while changing the caller's file, start line or location presence.
A matching-location control credits the call; the other fixtures retain its gap.

Removing both guards fails three regressions.
Removing either guard alone fails its wrong-location regression.
The restored coverage, compiler and core coverage suites pass 45 tests.
