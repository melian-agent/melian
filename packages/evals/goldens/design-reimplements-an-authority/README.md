# design-reimplements-an-authority

Drawn from [the ask-the-authority decision](../../../../docs/decisions/2026-10-12-ask-the-authority.md), which names no comparison finding: a change hand-parses a format a dependency already parses. The base loads its configuration with `yaml`. The head reads a note's YAML header by splitting each line at its first colon, so a quoted value keeps its quotation marks and a list comes back as text.
