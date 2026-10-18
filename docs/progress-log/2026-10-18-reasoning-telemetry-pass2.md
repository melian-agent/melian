# Reasoning telemetry: exact mutation survivors

[Pull request #153](https://github.com/melian-agent/melian/pull/153), pass 2, starts at e7126a65.

The host reported four surviving lines. Stryker 10.0.0 enumerated their exact mutants. Six replacements were applied by hand, tested and restored. Direct tests kill both proxy binding survivors. Ending a stream without its original receiver fails Pi’s private-field check. The model catalogue test checks the receiver by identity.

Two survivors are equivalent:

- `a1dd4f577fb8585e`: changing `signal === undefined` to false adds only an undefined signal; pi-ai reads its value with `options?.signal`.
- `e3ea59aeff662ae7`: changing `mapped !== undefined` to true adds only an undefined catalogue field, removed by both receipt writers. The two other true replacements on that line fail the observed-body test.

The `mutation/unmutated` advisory `a3ecc051d2917d75` records the maintainer’s ignoreStatic policy on a type-only migration. No production behaviour or decision changed. The implementation plan stays unchanged for this fix pass.

The full enumeration, failing output, restored runs and mutation inventory are in tmp/reasoning-telemetry-pass2-report.md and tmp/reasoning-telemetry-report.md. The coordinator must dismiss equivalents under the host round’s overrides and rerun the host mutation check.

Validation: 62 focused tests pass with source restored. The whole gate passes 4,894 tests and skips 53. It exits 1 on four existing sandbox ps failures: the real process test, both real mutation backend tests and the supervisor termination test. Formatting, type checking, tooling and dependency checks pass. There are no timeouts. The host gate and mutation rerun remain with the coordinator.
