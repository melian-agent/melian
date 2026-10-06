# Resolve one tier for checks and lenses

[Pull request #85](https://github.com/melian-agent/melian/pull/85), second fix pass, item 7.

reviewChangeset repeated its tier fallback for automatic checks and the manifest. It now resolves that tier once. The pipeline guideline records why optional per-lens provenance fields still establish a new stored reader version. The three migrations remain.
