# The CLI's git drops what core's git drops

[Issue #539](https://github.com/melian-agent/melian/issues/539), part one. The CLI's `git` in `packages/cli/src/repository.ts` now runs with core's `gitEnvironment`, which core exports for it, so a caller's `GIT_DIR`, `GIT_GRAFT_FILE`, `GIT_ALTERNATE_OBJECT_DIRECTORIES` and the rest of git's repository-local variables no longer reach it. [The decision](../decisions/2026-11-20-cli-git-runs-in-core-git-environment.md) records the cost: the caller's `GIT_CONFIG_COUNT` and `GIT_CONFIG_PARAMETERS` settings are dropped too.

`packages/cli/test/repository.test.ts` runs one test for each variable `git rev-parse --local-env-vars` names, and one that points `GIT_DIR` at another repository. Before the change 14 of them failed: 13 variables reached git, and the `GIT_DIR` read returned the other repository's `melian.yaml`. All 19 tests in the file pass after it. The existing test that the caller's `GIT_CONFIG_COUNT` setting reached git now asserts only the `core.useReplaceRefs` pin, since the ruling drops that setting.

## Mutants

The change guards trust: it decides which repository git reads and which tools run. `melian mutants list origin/main...HEAD --claims-in packages/cli/src/repository.ts --json --all` at `64c9951a1` lists three generated mutants, all on `repository.ts` line 9, and leaves `packages/core/src/git.ts` and `packages/pipeline/src/static.ts` unmutated because they send signals. [The inventory](2026-11-20-issue-539-mutants.json) holds every row with its claim. Each mutant ran by hand at `64c9951a1`, in a cloud container, against its named test alone, which passed unmutated first:

- `{}` for the options object, `16 * 1024 / 1024` and `16 / 1024` for the buffer bound: each fails "git's repository-local variables > reads the repository it was given though GIT_DIR names another". The empty object reads the other repository; both bounds leave a 16-byte buffer, which the 24-byte policy overflows.

`static.ts` signals nothing on the changed line; its one signal-shaped call, `kill -0` at line 643, probes and sends none, and the named tests never reach it. So the two mutants of the changed call ran there too, by text, since the enumerator lists none:

- Dropping `env: gitEnvironment()` fails "staticToolVersion > takes Melian's own copy when the checkout tracks node_modules, though GIT_INDEX_FILE names an empty index".
- `{}` for the options fails "staticToolVersion > reads the version of the checkout's own install, which is the one a run starts", since `stdout` is then a buffer and never equals `""`.

`git.ts` gains only the `export` of `gitEnvironment`, with its body unchanged, so it holds no new behaviour to mutate. `biome/object-by-path.grit` has no mutation adapter; `scripts/object-by-path.test.mjs` proves it on fixtures, with each case reported or not reported, and the gate's Biome step fails on `guardrails.ts` once its exclusion is lifted.
