# Mutation testing runs as a static check on the changed lines

Choice: `static.mutation` runs Stryker on Vitest over the lines the head adds or edits, in the head's worktree. A mutant that survives, or that no test covers, becomes a P2 finding of rule `mutation/untested-behaviour`, with the mutator and the mutated text in its message and the nearest test file in its "What to do". `Timeout`, `RuntimeError`, and `CompileError` mutants are notes. The check is off by default and on in Melian's own `melian.yaml`, in the `full` tier only. Stryker 10.0.0 is an exact-pinned root dev dependency of this repository. It runs from the reviewed checkout's own install, and Melian carries no copy: its 161 packages should not ride into every install, so a checkout without Stryker records a skip that leaves the review not reviewed, and `melian doctor` warns while the check is on. A lens-raised `untested-behaviour` on code a fix pass wrote resolves to advisory, unless it guards a trust or durability property.

Problem: a guard counts as tested only when a test fails with it removed, and a lens can only read for that. Example: a function `if (age >= 18) return "adult"` with a test that asserts `typeof classify(30)` is a string passes, and so does every mutant of it. [The first decision](2026-10-07-tested-means-a-failing-mutation.md) records the cost: fifteen rounds on one pull request, 27 unproven guards found by one inventory pass. Solution: run the mutation and let the tool say which guards no test missed. On that example the check reports two findings, covering six mutants on lines 2 and 3, in 3 seconds; it reports none once the test asserts both sides of 18.

Settings in `stryker.config.json`, one line each:

- `testRunner: vitest` and `plugins`: the Vitest runner, loaded by name.
- `vitest.related: true`: after the initial run, only tests related to the mutated file run for each mutant.
- `coverageAnalysis: perTest`: a mutant runs only the tests that cover it.
- `reporters: [json]`: the JSON report is the only output; no HTML, no dashboard, no clear-text.
- `incremental: true`: Stryker keeps results in a file. Melian points `--incrementalFile` into the run's scratch directory, so a run reuses nothing from an earlier one.
- `inPlace: true`: mutate the files of the throwaway worktree. Stryker's sandbox copy rewrites `tsconfig` files with `ts.parseConfigFileTextToJson`, which TypeScript 7 lacks.
- `disableTypeChecks: false`: the default writes `// @ts-nocheck` into every `src` and `test` file, which shifted the line numbers a golden's test reads.
- `ignoreStatic: true`: a static mutant sits in code that runs when a module loads, so every one reruns the whole suite. On this branch's own change, 80 of 536 mutants were static and Stryker estimated they would take 84% of the run's time, which on a 8 minute 26 second suite is hours. They come back `Ignored`, and the note that names each line holding an ignored mutant says so. The cost is that a changed top-level constant or regular expression is not judged.
- `concurrency: 2`: two test processes, so the check does not starve the lenses and the host.
- `timeoutMS: 30000` and `timeoutFactor: 2`: how long a mutant's tests may run before the mutant counts as a `Timeout`.
- `dryRunTimeoutMinutes: 10`: the initial run executes the whole suite, which took 8 minutes 27 seconds on this repository with two workers.
- `cleanTempDir: always`: no `.stryker-tmp` left behind.

Melian sets the mutate ranges, the reporter, the incremental file, and `--inPlace` on the command line, so a head's configuration cannot widen or empty them. The head's `stryker.config.json` otherwise drives the head's run, as `biome.json` does, and a change to it is a policy change.

The bound is 2,000 changed production lines, `static.mutation.maxLines`. Stryker's cost is one initial run of the whole suite, which does not depend on the change, plus a test run for each mutant, which does. This repository's suite took 8 minutes 27 seconds for the initial run, and a mutant of 21 on one 26-line range finished in about 30 seconds more. A 2,000-line change yields on the order of 2,000 to 4,000 mutants. At a few seconds a mutant on two workers, that is hours. So 2,000 is a ceiling, not a target, and the timeout of 3,600 seconds in `melian.yaml` ends a run well before it. A change past the bound records a skip with its reason. The bound counts changed lines, which is a coarse guard on wall time, and the timeout is the real one: a run past `static.mutation.timeout` also records a skip with its reason, not a failure.

What it gives up:

- Wall time. The initial run executes the whole suite before any mutant, so the check takes minutes on a small change, and it delays the review that waits on it. It stays out of the fast tiers.
- Only changed lines. A mutant is judged by the line it starts on. An old line whose behaviour the change altered from elsewhere is not mutated. A deletion-only hunk adds no line, so a deleted guard is not seen.
- Only the head. The base is not mutated, so there is no baseline to diff and no `pre-existing` finding.
- Vitest only, and TypeScript production files only. A test, fixture, golden, declaration, config file, or `dist` file is never mutated.
- One finding per line. Mutants on a line merge, and the message names the first.
- Equivalent mutants. Stryker reports some survivors that no test could kill. They are P2, which acknowledges and does not block.
- A head's own tests run. A head that fails its tests fails the initial run, and the check fails closed. The head's test code can also write the report, so the check is as trustworthy as the other static tools that run head code, and no more. The run's file-size limit is 1 GiB, not the 16 MiB of a static tool's report: Melian's own cache tests write 128 MiB archives, and the 16 MiB limit ended their processes with SIGXFSZ and failed the initial run.

Skips that let a review pass. A skip is not in `checks.allowSkip`, so by default it leaves a review not reviewed. The review grants leave itself for four skips of `static.mutation`, as it does for a lens with no paths, and keeps the reason in the record: a change with no production TypeScript lines, a change past `maxLines`, a run past its timeout, and a writer that is not trusted. The check is advisory in nature, and a required status must not error on the size of a change or the speed of a host, so an over-bound change passes without mutation rather than failing closed. Every other skip, such as a disabled check or a checkout without Stryker, still leaves the review not reviewed.

The trust rule for any check that executes head code. This is the first check that does: Biome, tsc, and Enola read the head's files and configuration but never run its JavaScript, while Stryker executes the head's test files, setup files, and `vitest.config.*`. A fork's pull request could add a test that reads `~/.pi/agent/auth.json` or `melian.secrets.yaml` and sends it out. Two layers apply, and a new check of this kind must take both:

1. The command gets a `HOME` and `TMPDIR` inside the run's scratch directory, and no variable the Melian process holds beyond `PATH` and `LANG`.
2. The check runs only when the head's writer is trusted. The committed `trust.writers` policy must hold, as it does for publication, and the host must vouch for the writer: for a pull request, its author needs write, maintain, or admin permission on the repository; a range review is the reviewer's own to run. Otherwise the check records a skip with leave whose reason says the writer is not a trusted one, and runs nothing. A review that names no writer gets the skip too, and `trust.writers: false` skips it for every writer.

The gap that remains, plainly: a trusted writer's tests still run with an open network, and they can read the checkout's own files, including `melian.secrets.yaml`, by absolute path. A sandboxed `ExecutionEnv`, with no network and no path to the reviewer's files, is the full answer. It is deferred to the milestone that brings container isolation.

What the head's own text can hide. Stryker marks a mutant `Ignored` when the head's source says so with a `// Stryker disable` comment, or its configuration excludes it. A note names each changed line that holds an ignored mutant, and a `forbidden-patterns` rule in the root `melian.yaml` flags the comment on added lines. Stryker reads each `--mutate` entry as a glob, so each glob character in a path is escaped, and a requested file that produced no mutants gets a note.

The advisory rule: once this check runs, a lens that raises `untested-behaviour` on code a fix pass wrote is duplicating the mutation result with a guess. Its finding resolves to advisory unless the code guards a trust or durability property, where a survivor still matters whatever the tool says. The rule is a reviewing convention in [AGENTS.md](../../AGENTS.md#validation). Nothing in the pipeline applies it yet.

Supersedes: none. It builds the static check the [first decision](2026-10-07-tested-means-a-failing-mutation.md) promised and ends its note that every `untested-behaviour` finding keeps its severity.
