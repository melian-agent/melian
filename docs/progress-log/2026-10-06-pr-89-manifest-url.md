# Manifest fields agree

For [pull request #89](https://github.com/melian-agent/melian/pull/89), manifest parsing binds each download URL to its declared source repository and tag. Wrong repository, wrong tag and NUL binary-path probes failed before the fix. Runtime validation no longer depends on the online release check to catch these mismatches.
