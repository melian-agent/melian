# Recorded version-3 checks document with a `static.mutation` record

`checks.json` holds the `melian.checks` snapshot, and the records `runChecks` returned, that the checks code wrote at `69475b44`, `main` before step 22. The checks document was version 3. This is recorded output, not a hand-built old shape.

The recording ran in a checkout of that commit, as a Vitest test in `packages/pipeline/test/`. It built a repository with `createRepository()` and the empty Vitest install, a base whose `melian.yaml` ran only `static.mutation`, and a head that changed one line of `packages/p/src/a.ts`. A fake `stryker` in the checkout's `node_modules/.bin` wrote an empty JSON report. It ran `runChecks` on memory storage with a writer's leave and fake processes, then read the document through `harness.snapshot`. No provider, credential or environment file was read.
