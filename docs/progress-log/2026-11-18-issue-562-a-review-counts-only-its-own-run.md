# A review counts a static check's findings only from its own run

[Issue #562](https://github.com/melian-agent/melian/issues/562): a stale static check run could overwrite a newer run's findings, and the newer run's repeat review then passed with its blocker gone. The maintainer ruled on 2026-11-18, in the coordinator's session, that a review counts a static check's findings only when their stamp is that review's own run, proved inside the commit that decides, and that a replaced check reads as not run. [The decision](../decisions/2026-11-18-a-review-counts-only-its-own-runs-findings.md) records the rule and the four details the coordinator agreed.

- The adjudication task, now version 8, takes the review's run in its input and asks `StaticProof.replaced`, the export's own proof, which checks another run replaced. It asks when it decides and again inside the commit that records. A replaced check reads as `failed`, its slot's findings are dropped, and the verdict is not reviewed.
- `runChecks` reuses a finished run only while the store proves each of its checks to be that run's, so a repeat review runs the check again and decides.
- The adjudication attach key holds the run, so a review of another run never attaches to the first run's verdict.

Tests: `packages/pipeline/test/stale-check-run.test.ts` holds issue #562's own sequence, the stale run sharing the review's request, a stale write after the review took its run, and a stale write after the verdict was decided and before its commit. The first failed on main at e421b5541 with `expected 'passed' not to be 'passed'` and passes at the head. `packages/pipeline/test/adjudication-v7-reopen.test.ts` resumes a version-7 task that main's code at e421b5541 recorded, under `test/fixtures/adjudication-v7-static/`.
