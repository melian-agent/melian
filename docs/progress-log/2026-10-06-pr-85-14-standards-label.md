# Include standards in the boundary label reference

[Pull request #85](https://github.com/melian-agent/melian/pull/85), seventh-round finding b8cf3568ea1fd06b.

The pipeline guideline's prompt-boundary list omitted standards, though UntrustedLabel includes it and worktree standards emit it. The list now names all seven labels. Existing prompt tests assert the standards label. No behaviour or design decision changes.
