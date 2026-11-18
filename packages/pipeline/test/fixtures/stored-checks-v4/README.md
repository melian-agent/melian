# Recorded version-4 checks and version-11 findings

`run.json` holds what main's check code wrote at `5a3effac`, the commit before [issue #528](https://github.com/melian-agent/melian/issues/528) stamped a check's sightings with its run. That code stored the `melian.checks` document at version 4, the `melian.checks` task at version 3, the `melian.check` task at version 4 and the findings document at version 11. This is recorded output, not a hand-built old shape.

The recording ran in a detached worktree of that commit, borrowing the checkout's `node_modules`, as a Vitest test in `packages/pipeline/test/` that imported the pipeline only from that commit's `src`. It built a repository with `createRepository()`: a base whose `melian.yaml` ran a `fast` tier of `static.biome` alone, and a head that added `debugger;` to `src/a.ts`. It ran that commit's `runChecks` on memory storage with fake models and a node execution environment, and Biome reported one finding. It then wrote the repository path, the base and head, the revision key, the run's request key, every `melian.checks` and `melian.check` task `storage.task` returned, and both documents through `harness.snapshot`. No provider, credential or environment file was read.

`test/check-stamp-reopen.test.ts` remaps the repository path and commits where it reruns a task.
