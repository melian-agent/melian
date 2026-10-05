# Verdict migration belongs to its stored shape

[Pull request #73](https://github.com/melian-agent/melian/pull/73), round ten, item 3: confirmed. The verdict document migrated inline, contrary to the stored-shape rule in `AGENTS.md`.

`VerdictState.upgrade` now owns the unchanged migration. The class also constructs and serialises the initial shape. The document delegates to it without changing its version or stored fields.

Validation: the existing migration tests remain. They cover version 2 evidence, version 3 verdict preservation, and version 4 walkthrough notes after reopening SQLite. The repository gate passes before this commit: 50 test files, 1,217 tests passed, one skipped and zero vulnerabilities.
