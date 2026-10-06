# Use the core rejection helper

[Pull request #85](https://github.com/melian-agent/melian/pull/85), thirteenth round, advisory ea617f3d0d75db43. Two source-error tests awaited Vitest rejection assertions directly.

Both now await rejection with Error, then assert the returned error's identity. This follows the core guideline without weakening either assertion. The source and standards suites pass all 138 tests. No design decision changes.
