# Base snapshot test

Confirmed 1ae8f8edd82d572c for [pull request #89](https://github.com/melian-agent/melian/pull/89). The fake now validates baseline pin, the baseline argument and base-specific facts. Base and broken head carry different generation markers. Deleting pin or substituting the head baseline fails before restoration. All six Enola tests pass.
