# 2026-10-22: a missing status identifies the pull request head

The decision requires a missing-status failure to name both the pull request and its head. The diagnostic on [pull request #168](https://github.com/melian-agent/melian/pull/168) named only the pull request. A regression assertion failed first because the description did not contain the head SHA.

The failure now includes the full pull request head SHA. All 90 command tests pass. Three hand mutations fail that test: omitting the SHA, naming the group SHA instead, and posting on the base. Failure assertions now derive the posted SHA from the fake's actual request path.
