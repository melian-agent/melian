# 2026-10-23: design.md split into linked section files

[Pull request #184](https://github.com/melian-agent/melian/pull/184) closes [issue #176](https://github.com/melian-agent/melian/issues/176). `docs/design.md` had reached 264 KB, near the 320 KiB read cap of the design lens. It is now 111 KB. Eleven top-level sections moved, with their subsections, to files under `docs/design/`, and the comparison subsection of Evals and testing has its own file.

Each moved section left its heading, its opening paragraph and a `Details:` link in `design.md`, so every `design.md#anchor` link still resolves. Subsections that other files link to stayed in place. The index loads only files that `design.md` links, so three Details lines also carry a fragment link to a decision or guideline that the moved text used to cite.
