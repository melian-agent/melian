# A static survivor's finding names the test files that ran

Amends: [the mutation-testing decision](2026-10-08-mutation-testing-as-a-static-check.md), the advice for a survivor that code outside a test also reaches.

Amends: [the mutation-reruns decision](2026-10-16-mutation-reruns-later-changes.md), the same advice.

Choice: the finding for a `Survived` mutant marked `static: true` names the test files that cover it, read from the report's `coveredBy` and `testFiles`: the first three in path order, and a count of the rest. It says that no other test file ran, because Stryker picks test files through Vitest's `related` filter, which follows only static and literal dynamic imports. When the report lists test files and the changed file's nearest test file exists but is not among them, the finding says so. The remedy names both moves: take a call out of a hook or a `describe` body, and reload a module with `vi.resetModules()` and a literal `await import()`.

Why: the old advice said to move the call into the test. On [pull request #165](https://github.com/melian-agent/melian/pull/165) the call was already inside the test, and the test file never ran, because it reached its module only through `vi.importActual`. [Issue #169](https://github.com/melian-agent/melian/issues/169) found the cause. The report already says which tests ran, so the finding reports that rather than guessing.
