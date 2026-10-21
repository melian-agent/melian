# Comparisons by round: migration and unattributed writes

Amends: [the rounds decision](2026-10-18-compare-rounds-exact-rule.md), version-1 comparison migration and the unattributed address

Problem: version-1 comparisons were written both before and after round IDs existed. A revision key cannot distinguish two minted rounds.
For example, build 1 at `0ee97219` wrote one comparison after minting two rounds at the same revision.
Assigning that comparison to a legacy round would invent its identity.

Version-1 comparisons migrate to a revision-keyed unattributed map in comparison document version 2.
The migration callback cannot read the sibling rounds document.
Readers resolve attribution in memory; writers resolve it inside their transaction.
A comparison maps to its revision's legacy round only where no minted round exists there.
Before a writer first mints a round, it preserves a marker for a comparison already present without minted rounds.
That marker proves legacy attribution after the mint.
Otherwise the comparison stays unattributed, preserving its matches and adjudication history.
Even one minted round supplies no automatic attribution.
The reopen fixtures come from main at `36122eb2` and build 1 at `0ee97219`.

`--round unattributed` addresses the named range revision's existing unattributed comparison.
It supports import, match, unmatch and adjudicate, for range writes only.
It refuses when no unattributed comparison exists at that revision.
It neither creates a round nor rematches against an unproven verdict.
Export keeps these entries separate, with their revision keys in JSON; statistics counts them apart from attributed comparisons.

Built in [pull request #162](https://github.com/melian-agent/melian/pull/162).
