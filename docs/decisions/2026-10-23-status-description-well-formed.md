# A status description is well-formed and never ends on half a surrogate pair

Amends: [the status-description cut decision](2026-10-22-status-description-cut.md), the length of the cut.

Amends: [the merge-group decision](2026-10-22-melian-review-on-merge-groups.md), test 15.

Choice: `setStatus` makes the description well-formed with `toWellFormed()` before it measures and cuts it, so a lone surrogate in the input becomes U+FFFD. It then cuts the prose in UTF-16 units and drops a trailing high surrogate before it adds "…", so the description is well-formed and at most 140 UTF-16 units. GitHub counts code points, and UTF-16 length is never smaller.

Why: a cut inside an emoji sent a lone surrogate. If GitHub refused it, a not-reviewed `error` failed to post and an earlier `success` stood. A prose of 91 characters then an emoji is now cut to 91 characters and "…".

Test 15 now reads: a description whose suffix is cut, or whose reviewed base is not exactly one trailing `; base <40 lowercase hex>`, is `failure`. A description whose prose was cut, such as `x…; base <hex>`, is accepted; only a cut suffix fails.
