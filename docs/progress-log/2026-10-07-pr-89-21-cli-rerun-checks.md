# test(cli): pin --rerun for a failed deterministic check

For [pull request #89](https://github.com/melian-agent/melian/pull/89), round 21. `review` now calls `runChecks` itself and passes `rerunFailed: options.rerun`. A CLI test fails `static.tsc` with a fake tool, then reviews with and without `--rerun`. Setting `rerunFailed` to false, or dropping it, fails the test.
