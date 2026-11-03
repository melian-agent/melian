# Exclude binary Bun lockfiles from mutation targets

For [pull request #250](https://github.com/melian-agent/melian/pull/250), add `lockb` to enumeration's existing data-extension expression.
Installation identity already recognises `bun.lockb`. Dependency-only changes now return an empty version-2 inventory.
This implements the existing data exclusion; unsupported source still fails closed.

At base `1db29aa6d7cf4310f0e3d18a60cd278a68f0fd7e`, the new pipeline regression failed with
`MutationEnumerationError: no mutation adapter handles bun.lockb`. The `bun.lock` text control passed.
Both ranges change only committed `package.json` and lockfile data, with no TS/JS delta.
The binary fixture contains NUL, and the test verifies Git's binary numstat before enumeration.
After the fix, both pipeline cases and the real-pipeline CLI case pass.
They assert the whole empty inventory, including version, base, head, adapters, counts and unmutated files.
The existing unsupported Scala, binary source and non-UTF-8 source cases remain unchanged.

The complete fix-only production inventory has two regex mutants and zero omitted.
Each was applied alone and killed by its named existing test in this pass.
Removing the end anchor fails the unsupported `src/code.md.scala` case.
Requiring `jpeg` fails the existing data-extension case on `data/value.jpg`.
A separate supplemental removal of `lockb` fails both binary Bun regressions while the text control passes.
The scratch runner restores source bytes in `finally` and verifies the original SHA-256 after every probe.
Inventories, tuple hashes, source hashes, commands, exit codes and actual output live under `tmp/pr250-bun-lockfile-fix/`.

The unexcluded focused enumeration and CLI run passed 341 tests and failed the known sandbox case:
`rejects a fallback entry inside a reviewed tree even when its manifest is outside it`.
Git initialisation under `node_modules` was denied. The test remains unchanged.
Excluding that exact test gives 341 passes and one skipped test across both suites.
Repository lint and type checking pass on Node 24.18.0; lint reports five existing informational notices.
The coordinator owns the whole host gate, exact-head CI and fresh final reviews; this executor did not run them.
