# An adjudication key before the code version

`decided.sqlite` was written by main at `a69fac993`, using its own review and adjudication code with fake models. No stored field was assembled by hand. The review is mutation-only, so it spends no model call. `recorded.json` names the changeset, the revision and the review index's adjudication entry as main stored it, its key the bare input `JSON.stringify` wrote. `repo.bundle` holds the review's commits, so a test can replay the range.

`capture.mjs` reproduces the capture when copied to that tree's root. The capture ran from `git archive a69fac993`, extracted into scratch space with its own `npm ci --ignore-scripts`, under Node 22 with `--conditions=@melian-agent/source`, passing an absolute output directory. It imported only that tree's code and dependencies.

`adjudication-key-reopen.test.ts` copies the store to a temporary directory, reviews the same range under the current code, and checks that it decides again once, under a key holding the same input plus `code`, and attaches on the next review.

`pending.sqlite` is `decided.sqlite` with a second adjudication task that main's own code created from the stored input, and the review index pointed at it. `capture-pending.mjs` made it, from the same tree, with a harness that installs no extension, so the task stayed pending, as after a crash before its phase. `pending.json` names the task. The reopen test resumes it under the current code, which fails it, and checks that the next review decides the revision again under a new task.

`pending-8.sqlite` is `decided.sqlite` with a version 8 adjudication task that main's own code created at `56f7fb059`, from the stored input plus main's `code`, and the review index pointed at it under main's key. `capture-pending-8.mjs` made it, the same way, from `git archive 56f7fb059` with its own `npm ci --ignore-scripts`. `pending-8.json` names the task, its version and its key. The reopen test resumes it under the current code, which fails it for naming no `packages`, and checks that the next review decides again.
