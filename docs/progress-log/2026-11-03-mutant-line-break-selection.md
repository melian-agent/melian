# Committed mutation selection uses compatible line breaks

For [pull request #250](https://github.com/melian-agent/melian/pull/250) and [issue #239](https://github.com/melian-agent/melian/issues/239), enumeration now sets aside whole files containing lone CR, U+2028 or U+2029.
It retains explicit notes, including when no adapter runs. LF and CRLF controls still enumerate twelve mutants from four Git lines.

Real committed-source tests first reproduced empty inventories without notes and a non-empty inventory mutating unchanged `y > 1` instead of changed `x + 1`.
The regressions cover comments, strings, lone CR inside CRLF, separator-only edits, mixed files, CLI and compatibility routes.
Evidence and individual mutation runs live under `tmp/pr250-approved-phase-b/`.

The installed instrumenter's range probe and Stryker `project-reader.js` show the static runner constructs the same coordinates.
No real static run reproduced the defect. Its outcomes remain unchanged; static reproduction and selection are follow-up work.
The [decision amendment](../decisions/2026-11-03-mutant-line-break-selection.md) records this limit.
The coordinator's whole host gate remains pending.
