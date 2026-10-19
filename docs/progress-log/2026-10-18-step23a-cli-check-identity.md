# Step 23a: preserve the CLI check identity

The first implementation in [pull request 152](https://github.com/melian-agent/melian/pull/152) handled automatic checks but missed the CLI’s upfront check run. The CLI needs that run before review for caller context. Passing only its records let a cold run with identical results attach to the previous adjudication.

A real-command regression failed on `ebf7fc89`: a normal review and a cold review listed only `r1`. The test uses a docs-only diff and the real mutation-check skip, without Stryker or model requests. A native Node probe reproduced the same failure.

The CLI now passes its existing identity through `ReviewOptions.checkRun`. The pipeline uses its automatic identity when it runs checks, or the host’s otherwise. This changes no stored task or document version. The test now sees `r1` and `r2`; another cold review attaches to `r2`.

The regression and 19 check-wrapper tests pass, as do type checking and the Node probe. Removing either handoff, or dropping the automatic identity, fails the matching test. The inventory now records 69 distinct mutations killed in 75 runs. No original test assertion or input changes. The plan status stays unchanged; the local report records the full gate and exact-head CI.
