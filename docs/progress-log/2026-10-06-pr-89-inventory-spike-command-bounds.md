# test(evals): prove spike query and output bounds

For [pull request #89](https://github.com/melian-agent/melian/pull/89), The analyser fixture enforces query depth and node caps. A 32 MiB padded report proves the subprocess file limit. All three command mutations fail; both restored spike tests pass.
