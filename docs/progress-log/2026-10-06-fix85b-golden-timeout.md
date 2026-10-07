# Give scripted golden reviews time to finish under load

[Pull request #85](https://github.com/melian-agent/melian/pull/85), second fix pass, gate follow-up.

The full gate passed 1458 tests and timed out only on durability-partial-handoff. That golden passed alone with its body close to five seconds. The first fix pass recorded the same timeout. Scripted golden reviews now allow sixty seconds for their temporary git repositories and durable conversations. Their assertions and snapshots are unchanged.

The second full gate passed all 57 test files: 1459 tests passed and 50 skipped, with no audit vulnerabilities. Node 24.18.0 ran it with two Vitest workers and MELIAN_STATE_DIR unset.
