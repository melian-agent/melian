# Preserve publication upgrades after the main merge

[Pull request #86](https://github.com/melian-agent/melian/pull/86) now writes published-document version 7. Main already writes version 6 for standards paths, so reusing that version would skip attribution migration. SQLite tests reopen both versions 5 and 6 and require default writer trust without invented identities.

The recorded version-5 snapshot keeps its verdict, standards paths and version refusal checks. Its publication expectation now includes the attribution migration. No design decision changes.
