# The design lens judges against the base text of a decision

Choice: the `design` lens reads each decision file and design section at the base revision and treats that text as the standard. A head-side edit to a decision is a change to judge. The lens reports a weakened trust, access, or fail-closed decision even when the decision file is edited alongside it, and quotes the base text it compared against.

Why: the first draft read decisions at the head and excused a departure when the same change edited the decision file. The author under review then wrote the standard that excused them: a change that made an omitted `verify` argument skip signature verification passed if it also edited the decision to say so. The other lenses take their standards from the base for this reason.

Supersedes: [2026-10-07-design-lens.md](2026-10-07-design-lens.md), only in that the lens reads each decision at the base revision.
