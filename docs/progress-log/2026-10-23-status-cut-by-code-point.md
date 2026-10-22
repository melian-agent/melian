# 2026-10-23: a cut status description no longer splits a surrogate pair

An attacking review of [pull request #168](https://github.com/melian-agent/melian/pull/168) found that `setStatus` cut the prose in UTF-16 units, so a cut could leave the first half of an emoji. JSON then sent a lone surrogate, and if GitHub refused it, a not-reviewed `error` failed to post and an earlier `success` stood.

`setStatus` now drops a trailing high surrogate from the cut prose before it adds "…". The result stays within 140 UTF-16 units, which is never fewer than GitHub's count of code points. The test puts a non-BMP character exactly at the cut, with and without a reviewed base, and a third keeps an earlier whole emoji.

The same review found test 15 ambiguous. [A new decision](../decisions/2026-10-23-status-cut-by-code-point.md) amends it: only a cut suffix fails, not cut prose.
