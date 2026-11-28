# conventions-clean

Seeded from finding 7 of the [comparison record](../../comparisons/2026-10-03-pr-10.md) for [pull request #10](https://github.com/melian-agent/melian/pull/10): the progress-log entry lacked links. This is the clean counterpart of every conventions golden: the change keeps each rule in its `AGENTS.md`, and carries choices a reviewer might word or shape differently that no rule addresses, so a review must report nothing.

`toTsv` writes a name that starts with `=`, `+`, `-` or `@` behind an apostrophe, so a pasted cell holds text, not a formula. As first written it passed such a name through, and a receipt item named `=1+1` became a formula in the spreadsheet `toTsv` is for: a real defect a live lens rightly reported. [Issue #663](https://github.com/melian-agent/melian/issues/663) made the change clean in fact; `toCsv` keeps the shape the base already had.
