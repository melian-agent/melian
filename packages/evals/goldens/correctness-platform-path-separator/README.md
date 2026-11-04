# correctness-platform-path-separator

Seeded from finding 8 of the [comparison record](../../comparisons/2026-10-03-pr-11.md) for [pull request #11](https://github.com/melian-agent/melian/pull/11): native paths were compared with forward slash literals in the harness boundary test.

The golden expects `correctness`'s `wrong-result`. The base handles the declared input; the changed line in the head computes the wrong result. The trees deliberately contain this defect. They add no tests, so the source finding's test setting does not hand this case to `tests`.
