# test(core): pin the default Enola timeout

For [pull request #89](https://github.com/melian-agent/melian/pull/89), Default configuration tests assert the 300-second Enola deadline. Its zero-deadline mutation fails; all 120 restored configuration tests pass.
