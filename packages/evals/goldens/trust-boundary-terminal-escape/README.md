# trust-boundary-terminal-escape

Seeded from finding 2 of the [comparison record](../../comparisons/2026-10-03-pr-13.md) for [pull request #13](https://github.com/melian-agent/melian/pull/13): the terminal renderer printed `artifactLocation.uri` raw, so a path with escape sequences, a newline, or a bidi override reached the terminal. `trust-boundary-clean-summary` is its clean counterpart.
