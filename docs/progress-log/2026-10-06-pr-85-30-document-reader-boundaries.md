# Prove provenance records refuse older readers

The mutation inventory for [pull request #85](https://github.com/melian-agent/melian/pull/85) strengthens the recorded version-5 migration test. After the current readers write per-lens standards, version-5 readers must refuse the verdict and publication documents. Downgrading either current reader to version 5 fails the test. No production behaviour or design decision changes.
