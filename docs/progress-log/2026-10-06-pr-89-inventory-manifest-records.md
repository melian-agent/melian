# Enforce manifest record patterns

[Pull request #89](https://github.com/melian-agent/melian/pull/89) now rejects tool and platform keys outside their declared patterns. Before this fix, a tool named ../enola passed validation. The pattern constrained matching properties but left other keys allowed. Both records now receive the existing strict options. This enforces the existing validation decision.

Tests cover unknown keys, dates, repository slugs, empty miss references, whitespace exceptions, empty platforms and typed diagnostics. All 24 manifest mutations fail tests, including removal of either new strict record option. The restored suite passes 20 tests.

The core guideline records the TypeBox record trap. No dependency changed.
