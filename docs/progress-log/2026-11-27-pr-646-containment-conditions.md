# Pull request 646 proves the probe conditions in the round's containment step

Builder agent, for [pull request #646](https://github.com/melian-agent/melian/pull/646) and [issue #644](https://github.com/melian-agent/melian/issues/644).

The Melian round at 01e4d7f47 found that the round's containment step checked the wrong environment. This pull request makes the root `melian.yaml` name `probe.conditions`, so every round's probes start with `NODE_OPTIONS`. `scripts/round-probe-containment.mjs` opened its probe with `probe.read` alone, and its exact environment check had no `NODE_OPTIONS`. So the step proved an environment no round runs. The [containment decision](../decisions/2026-11-16-round-job-probes-behind-containment.md) promises that any change to what a probe sees fails the step.

The coordinator answered on 2026-11-27 that the fix keeps that decision's promise as written and needs no ruling. The step now reads the base's whole `probe` policy through `probePolicy`, passes its conditions to `Probe.open` when it names any, and expects `NODE_OPTIONS` exactly when it does. Otherwise it still refuses `NODE_OPTIONS` as an unexpected variable.

The tests came first. On the old code, "expects NODE_OPTIONS exactly when the base names probe conditions" failed with the plan's 33 names against the 34 expected. "hands the probe the probe.conditions of the base the round names" failed with `expected undefined`, and the `probePolicy` tests failed because the function did not exist. Nine other `main` tests failed too, as fallout: their fake policy reader now answers the new shape, which the old `main` spread as an array. After the fix the file's 100 tests pass. A `judge` test covers both directions: `NODE_OPTIONS` refused when the plan expects none, and missing when the plan expects it.

[The inventory](2026-11-27-pr-646-containment-conditions-mutants.json) of 07b59fe2e lists 25 generated mutants in the script, and each was run by hand. Each named test was collected alone, passed unmutated, and failed mutated. Ten sit on the `LANG` filter, which the fix only moved into the new array.
