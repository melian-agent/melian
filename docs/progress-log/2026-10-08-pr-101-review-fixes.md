# Review-of-record fixes for pull request 101

For [pull request #101](https://github.com/melian-agent/melian/pull/101), `fix(pipeline): keep abandoned providers locked on live attachment` aligns lens and verifier read-ahead with live attachment. Real-kill regressions hold cross-provider fallback requests through attachment and check credential commands. `test(cli): prove cross-provider lens fallback credentials unlock` adds a route that fails over to a second provider and checks its credential before either lens request. Mutations and validation are recorded in `tmp/fix101-review-report.md`.
