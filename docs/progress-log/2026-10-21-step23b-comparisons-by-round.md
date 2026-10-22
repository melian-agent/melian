# Step 23 build 2: comparisons by round

[Pull request #162](https://github.com/melian-agent/melian/pull/162) builds item 2 of [the rounds decision](../decisions/2026-10-18-compare-rounds-exact-rule.md). Build 1 landed in [pull request #152](https://github.com/melian-agent/melian/pull/152).

Comparison document version 2 keys comparisons by full round ID. Range imports, matches, unmatches and adjudications accept an explicit round. Without one, a write uses the current round and refuses an undecided round. An earlier decided round keeps its own verdict when the current round is undecided.

Version-1 comparisons map to a legacy round only where the revision has no minted round. Others remain unattributed, with their matches and adjudication history. Migration resolves sibling round state inside the writer’s transaction, or in memory for detached reads. Export lists unattributed records separately; stats counts them apart. JSON keys attributed comparisons by round ID.

Reopen fixtures were recorded by the requested historical code: main at `36122eb2`, and build 1 at `0ee97219`. The second holds two minted rounds at one revision and a comparison written after both. Tests copy each closed SQLite store before reopening it.

The tests failed first against `0ee97219`: revision slots collapsed two comparisons, explicit round writes were ignored, adjudication searched older comparisons, and migration could not preserve unattributed identity. Hand mutations then found gaps for frozen undecided rounds, current-round gating, comparison-only legacy records, judgement order and CLI validation. The added tests kill those mutations.

The local report and mutation inventory live at `/Users/tal/dev/Melian/tmp/m2/scratch-step-23b/step23b-report.md`. No live model ran. GitHub membership, new pull-request writes and refresh remain for builds 3 and 4. The coordinator runs the live review loop and the host gate. Self-review also reproduced an upgrade transition: minting before the first comparison command made a known legacy record look unattributed. The writer now records that known legacy attribution before minting, within its own transaction.

Implementation: `b0a9b0f1`. The whole gate on that commit’s tree passed lint, types and audits, with 5,484 tests passed, 53 skipped and four sandbox process failures. The seatbelt denies `ps`; Stryker and the whole host gate remain coordinator work. A follow-up covers round-ID bounds in comparison routing, including zero, leading zeros and overlong hashes, and validates explicit legacy and pull-storage round IDs.
