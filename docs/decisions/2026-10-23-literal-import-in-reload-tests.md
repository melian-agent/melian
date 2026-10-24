# A test that reloads a module imports it with a literal path

Amends: [the dist-only-at-publish decision](2026-10-05-dist-only-at-publish.md), the shim as the one exception to the rule against `await import()`.

Choice: a test may call `vi.resetModules()` and then `await import()` with a literal path, inside the test, to put a module's load-time code under that test. It is the second exception to the rule against `await import()`, beside the CLI shim.

Why: Stryker runs a mutant against the test files Vitest's `related` filter keeps, and that filter follows only static imports and literal dynamic imports. `packages/pipeline/test/mutation-paths.test.ts` reached its module through `import type`, which is erased, and `vi.importActual(...)`, which is a call. Vitest dropped the file, so its 16 mutants survived on unrelated tests that happened to reload the module. With a literal `await import()` the same test kills them. [Issue #169](https://github.com/melian-agent/melian/issues/169) holds the evidence. A static import does not do the job alone: it loads the module outside any test, and Stryker credits a mutant only to the tests that reach it inside one.
