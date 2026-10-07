# CommonJS import coverage

Confirmed sixth-round finding d060f8a77940e0b1 for [pull request #89](https://github.com/melian-agent/melian/pull/89).
The compiler omitted repository-resolved import-equals declarations.
Read external module references and preserve their type-only flag.
Bump the coverage identity to invalidate measurements with the old denominator.

The CommonJS fixture counts two imports and two uncovered edges.
Removing extraction fails the regression; seven existing compiler tests pass.
The restored compiler and coverage artifact suites pass 25 tests.
