# Top-level declarations for [pull request #102](https://github.com/melian-agent/melian/pull/102)

Fix commit 26ef3e9c68f0a2053483307cb64205ca43b41759 addresses round seventeen’s confirmed finding ad3980ad10424c52. It replaces the source-text rule from commit 9075f432a73fdd039e2a55d2e93753fb838c2b21 with the maintainer’s decoded-text grammar.

A quoted paragraph containing Context: a followed by Supersedes: old.md has one mdast text node. Its raw second source line keeps the quote prefix. A list continuation keeps indentation. Source slices therefore treated first and later contained lines differently.

Declarations now start with Supersedes: at a line’s start in a paragraph whose parent is the root. Quotes, list items and other containers are prose, with no declaration or parse error. Paragraph text comes from decoded node values, split on the shared CommonMark CR, CRLF and LF pattern. Positions count source lines; offsets supply no declaration text. A decoded piece count that disagrees with the source span still refuses parsing and base loading with DecisionFilesError code invalid. Thus `old&#46;md` names old.md, while `&#10;` and `&#13;` in root paragraph text fail closed. The design, decisions guideline, package rules and branch-owned Markdown decision state this grammar in the fix commit.

Regressions cover the review’s quote continuation, list continuations, a top-level declaration after contained prose, and contained malformed destinations and entity newlines. Graph assertions keep old.md active when only contained prose names it. Decoded-prefix and sentinel tests follow CommonMark’s reading. All 443 decisions tests passed.

Four mutations failed their selected tests: source-offset text failed four decoded-text tests; removing the mismatch guard failed both entity-newline tests; removing the root-parent guard failed all nine container tests; removing the inclusive span’s +1 failed four decoded-text tests. Each mutation was restored. The root-parent guard and early return are the only new production branch.

The full gate passed on its first run under Node 24.18.0 with MELIAN_STATE_DIR unset and VITEST_MAX_WORKERS=4. It passed 111 test files and 3,455 tests, with 50 skipped. Biome applied no fixes. Type checking, dependency checks, tool validation and audit passed. No timeout retry or real provider call was needed. The implementation plan and comparison records remain untouched.
