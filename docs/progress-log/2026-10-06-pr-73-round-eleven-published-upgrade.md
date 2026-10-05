# Published migration belongs to its stored shape

[Pull request #73](https://github.com/melian-agent/melian/pull/73), round eleven, item 2: confirmed. The published document migrated inline, contrary to the stored-shape rule in `AGENTS.md`.

`PublishedState.upgrade` now owns the unchanged migration. The class also constructs and serialises the initial shape. The document delegates to it without changing its version or stored fields.

Validation: both existing migration tests pass. They check version 3 reply preservation and version 4 ledger-history pruning after reopening SQLite. The repository gate passes before this commit: 50 test files, 1,218 tests passed, one skipped and zero vulnerabilities.
