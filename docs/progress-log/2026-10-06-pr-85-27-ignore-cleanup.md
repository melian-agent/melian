# Prove ignore scratch directories are released

The mutation inventory for [pull request #85](https://github.com/melian-agent/melian/pull/85) strengthens the revision ignore tests. They require removal of the scratch directory after a successful check and after a read failure. Removing the finally cleanup fails both tests. No production behaviour or design decision changes.
