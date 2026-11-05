# Refuse enumeration results that finish after the deadline

For [pull request #250](https://github.com/melian-agent/melian/pull/250), enforce the approved elapsed budget after successful work.
The adapter checks before parsing worker output and after scratch cleanup.
The listing checks after adapter completion and after installation hashing and inventory construction.
These success-path checks preserve syntax, import and invalid-output errors when cleanup crosses the deadline.
The [bounded protocol](../decisions/2026-11-03-bounded-mutant-protocol.md) and [direct-call cap](../decisions/2026-11-04-direct-enumeration-deadline.md) remain unchanged.

Against base `e4f828136e0367a9658cb9b575a848db4ac2caff`, five deterministic expiry regressions failed because work returned success.
The five controls at 119999 milliseconds and three error-precedence cases passed.
Each expiry case advances monotonic time to exactly 120000 during its named phase.
The worker and adapter fakes validate complete requests. Parsing and cleanup hooks run the actual operations.
After the fix all thirteen cases pass.

The complete fix-only production inventory contains five mutants, with none omitted.
Each mutant fails its named test when applied alone, following a passing baseline:

- Removing the worker-completion check parses expired output; the test observes one parse instead of zero.
- Replacing the mapped batch with `{}` fails the exact batch assertion.
- Removing the check after cleanup returns a late batch.
- Removing the adapter-completion check calls the inventory factory after expiry, despite the final check.
- Removing the final listing check returns a late inventory.

Four separate guard-removal probes also fail. The cleanup-check probe covers both parsing expiry and cleanup expiry.
The scratch runners restore original source bytes in `finally` and record tuple hashes, source hashes, commands and actual output.
The progressive inventory, runners, before/after logs and report live under `tmp/pr250-postwork-deadline-fix/`.

Node 24.18.0 lint and type checking pass. Lint retains five existing informational notices.
The initial enumeration and CLI run passed 356 tests and failed the unchanged sandbox-dependent Git initialisation under `node_modules`.
Excluding only `rejects a fallback entry inside a reviewed tree even when its manifest is outside it` gives 356 passes and one skipped test.
The coordinator owns the full host gate and exact-head reviews after this fix; this executor did not run them.
