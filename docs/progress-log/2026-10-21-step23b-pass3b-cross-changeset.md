# Step 23 build 2, pass 3b: guard explicit-round writes

[Pull request #162](https://github.com/melian-agent/melian/pull/162) refuses a range write when the resolved range and explicit round name different changesets.
The refusal names both changesets before resolving a storage path or opening a store.
An unresolved range still writes through the round's own changeset, preserving deleted-branch writes.
It supplies no comparison target, so an import keeps the stored target or leaves it absent.

The tests first reproduced all four cross-changeset routes opening the wrong store.
Imports also recorded the wrong target, including unresolved range text on a new comparison and one without a target.
The fix passes both comparison CLI test files: 109 tests.
The four existing deleted-branch write tests remain unchanged.
Resolved canonical aliases still work and record their target; a stored target survives an unresolved import.
All nine hand mutations fail a relevant test, including refusal before any storage lookup or open.
The coordinator's pass-3b report records each mutation and both reproduction runs.

Both whole-gate runs pass 5,525 tests and fail the same four sandbox process checks, without timeouts.
Three report `ps failed: undefined`; the supervisor fixture takes its error path when `ps` is denied.
Formatting, TypeScript, dependency checks and the audit threshold pass.
The host gate and automated mutation check remain for the coordinator.

The branch's migration decision, design and CLI guideline now state the cross-changeset rule.
No stored shape changes, and this fix pass leaves the implementation plan unchanged.
