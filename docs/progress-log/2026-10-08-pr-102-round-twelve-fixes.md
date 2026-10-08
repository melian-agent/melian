# Round twelve fixes for [pull request #102](https://github.com/melian-agent/melian/pull/102)

Three commits close the confirmed round-twelve findings:

- ff9b5dc5, fix(decisions): refuse absolute design path syntax. Closes Codex’s medium finding that literal or encoded absolute paths can re-enter through the synthetic repository root. Tests include the target file and cover slash, backslash and encoded spellings. Decision-root supersession links and network URLs keep their established meaning.
- 4fe8e0ac, fix(decisions): align heading lines with evidence reads. Closes Melian’s P2 finding that mdast counts lone CR endings while read_file and evidence citations count LF. Heading line numbers use LF before node start offsets. Lone-CR and mixed-ending cases include Setext headings.
- 8fd0ddcf, fix(decisions): preserve filename padding through URL parsing. Closes Melian’s P2 finding that leading and trailing filename spaces disappear. Every C0 control and space is percent-encoded before URL parsing. Tests distinguish literal leading-space and unpadded decisions and preserve trailing-space destinations.

Twenty-four retained mutation probes failed named tests. One malformed exploratory regex mutation is recorded as unproven; its corrected probe failed the intended regression. The inventory covers the new absolute-path guard, its repository-relative and network exceptions, the remaining repository bound, heading offsets and LF counts, and both encoding bounds. Every production mutant was restored. The report records each probe and failing test under tmp/fix102-r12-report.md.

The affected suites and type checking passed after each fix. The full gate passed on its first run: 111 test files, 3,343 passed tests and 50 skipped tests. Biome applied no fixes. No timeout retry was needed. The report carries the gate’s summary lines verbatim; its log is tmp/fix102-r12-check.log.

The Markdown decision and related descriptions now match the code. No implementation-plan status changed. The comparison record remains on its own branch. No real provider was called.
