# Prove every standards inventory diagnostic

The mutation inventory for [pull request #85](https://github.com/melian-agent/melian/pull/85) adds six doctor cases. They cover a non-repository, an empty inventory, Error and string failures, unequal warning counts and an all-symlink remainder. The existing remainder assertion now rejects an extra plural suffix. Every corresponding mutation fails. No production behaviour or design decision changes.
