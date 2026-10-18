# Step 26 pass 3: Markdown mutation coverage

[Pull request #150](https://github.com/melian-agent/melian/pull/150).

Direct MarkdownDocument tests cover retired sections with nested and formatted headings, complete table delimiters, row whitespace, sentence-mask alignment, declaration coordinates and destination identity. All 72 tests pass after restoration. Production behaviour is unchanged.

The installed Stryker instrumenter enumerated every mutant starting on the seven reported Markdown lines. Each replacement ran alone; the inventory names the failing test and log. Finding `4f5a3fdf1f81de75` has one equivalent replacement: changing `retired !== undefined` to `true` still compares the heading depth with undefined, which is false. The other mutants fail assertions. The final pass report records the whole gate.
