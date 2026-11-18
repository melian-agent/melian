# An adjudication key before the code version

`decided.sqlite` was written by main at `a69fac993`, using its own review and adjudication code with fake models. No stored field was assembled by hand. The review is mutation-only, so it spends no model call. `recorded.json` names the changeset, the revision and the review index's adjudication entry as main stored it, its key the bare input `JSON.stringify` wrote. `repo.bundle` holds the review's commits, so a test can replay the range.

`capture.mjs` reproduces the capture when copied to that tree's root. The capture ran from `git archive a69fac993`, extracted into scratch space with its own `npm ci --ignore-scripts`, under Node 22 with `--conditions=@melian-agent/source`, passing an absolute output directory. It imported only that tree's code and dependencies.

`adjudication-key-reopen.test.ts` copies the store to a temporary directory, reviews the same range under the current code, and checks that it decides again once, under a key holding the same input plus `code`, and attaches on the next review.
