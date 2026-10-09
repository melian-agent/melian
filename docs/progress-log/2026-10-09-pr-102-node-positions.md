# Node-position declaration fix for [pull request #102](https://github.com/melian-agent/melian/pull/102)

Melian round fifteen on 38b57ae4 confirmed two findings about erased declaration boundaries: 75ff70233b326a64 and 1936ce4edd6fb6cc. A multiline code span joined a later context link to Supersedes and made its decision inactive. HTML, link labels and images could erase the same boundary.

Fix commit 978b87c9 takes physical lines from each inline node’s mdast start and end positions. Links belong to their start line. Opaque nodes mark every line they span. The shared CommonMark pattern splits text inside text nodes; evidence coordinates still count LF only. The branch’s Markdown decision, design document and decisions guideline state this contract.

The regression table pairs single-line and multiline nodes across CR, CRLF and LF. It checks the exact round-fifteen code span, HTML, inline and reference link labels, inline and reference images, later bare text and formatting. Graph assertions keep the context decision active. Final-line opacity pairs prevent prose after a closing delimiter from inventing a declaration mid-line.

Finding 1b6ebffcecd1c934 identified missing malformed-local-destination coverage. Fix commit 673de959 proves that `Supersedes: [Old](old%ZZ.md)` refuses both DecisionFile.parse and DecisionFiles.load. Both tests assert the invalid code and destination diagnostic, with valid controls beside them.

All twelve mutations failed tests. They cover restoring reconstruction, using end.line for start.line, the inclusive paragraph allocation, the text loop and its start and end, both link-condition arms, the opaque loop and its end, skipping link children, and swallowing LocalDestination.resolve errors. The mutation inventory and failing test names are in tmp/fix102-positions-report.md.

The full gate passed on its first run with MELIAN_STATE_DIR unset and four Vitest workers: 111 files passed, 3,404 tests passed and 50 skipped. Biome applied no fixes; the audit found no vulnerabilities. Its log is tmp/fix102-positions-check.log.
