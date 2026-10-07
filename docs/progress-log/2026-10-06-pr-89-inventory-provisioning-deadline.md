# test(pipeline): pin cache location command timeout

For [pull request #89](https://github.com/melian-agent/melian/pull/89), The common-directory test now checks the ten-second git deadline. Its zero-deadline mutation fails; both restored provisioning tests pass with MELIAN_STATE_DIR unset.
