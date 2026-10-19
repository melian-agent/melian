# Step 23 build 2 must migrate comparisons written after build 1

Requirement for build-plan item 2 of [the rounds decision](../decisions/2026-10-18-compare-rounds-exact-rule.md), carried from [pull request #152](https://github.com/melian-agent/melian/pull/152).

Build 1 still writes version-1 comparisons under revision keys. A comparison first written after build 1 can belong to a minted round. Build 2 must handle those stores as well as stores written before rounds existed. Hashing every version-1 revision key into a legacy round ID can assign a comparison to a round the store never held.

PR 2 must carry this requirement in its build plan, implementation and reopen tests. Its fixtures must include version-1 comparisons written by build 1's own code after minting rounds. The decision already exists on main and remains unchanged in this pass.

Build 1 now records round IDs in publisher targets and pending publish tasks. Minted targets read frozen verdict copies. Legacy targets migrate to their revision's legacy round. Publisher/task versions are 3/6; the published document stays at 8.

Implementation: `4b7c06ff`. Genuine SQLite captures from main and build 1: `335921ad`. Publication and reopen tests: `474b3e19`. Design and pipeline guidance: `2b5a7546`.

The reproductions failed before the target and frozen-copy fixes. Pass 3 killed all 26 hand mutations. Pass 4 passed 71 focused cases and four task-version reopen cases. Its full gate and any sandbox denials are recorded in `tmp/step23a-pass4-report.md`. Automated mutation proof and the host gate remain coordinator work. This fix pass leaves the implementation plan unchanged.
