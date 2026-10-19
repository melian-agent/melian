# Thinking routes: prove live entry forwarding

[Pull request #157](https://github.com/melian-agent/melian/pull/157), pass 5, addresses round 1 findings `6a48d1f5` and `9fcda588`.
The real live entry now runs in separate triage and lens tests with credential discovery replaced by a fake.
The tests use the real reporters and runners, and inspect the fake provider’s request bodies for high and medium thinking.
Deleting each forwarded thinking value fails its body assertion.
Both tests pass after restoration. No production behaviour changes.

Separate test files keep module identity intact when running the entry once per mode.
Resetting the full module cache would split the opaque model handle’s WeakMap and Standards class identity from their consumers.
Each file retains a static entry import for Vitest’s related-test selection, mocked only during collection.
The pass report under `tmp/m2/scratch-thinking/` records the mutation runs and full gate result.
The implementation plan’s status stays unchanged.
