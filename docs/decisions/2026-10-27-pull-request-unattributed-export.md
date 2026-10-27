# Pull request export preserves unattributed comparison records

Amends: [the comparisons-by-round decision](2026-10-21-comparisons-by-round-as-built.md)

Problem: a version-1 comparison cannot be assigned to one of two rounds at its revision. The first pull request membership snapshot hid that comparison from export. Its matches and replacement adjudication history remained in storage but disappeared from the record.

Pull request export keeps these raw unattributed comparisons from the pull request's own storage and from every storage holding a current member, including an unreachable member. It excludes foreign-only stores. It leaves the entries unattributed and guesses no round.

JSON keeps the existing revision-keyed `unattributed` map. Two different stores can hold different comparisons at the same revision. `ComparisonExport.renderJson` refuses that collision with a typed `unattributedCollision` error naming the revision and stores. The error directs the reader to Markdown. The command emits no JSON and leaves an existing output file untouched.

Markdown keeps both records and their current adjudications. It does not print every replacement-history entry. The complete histories remain in their stores; aggregate JSON cannot represent both under one revision key and refuses until a separate format decision supplies a representation. An ordinary single-store or noncolliding export keeps its existing JSON shape.

This adds no stored shape or namespace. Existing range and `--round` behaviour and the deferred aggregate-score question are unchanged.
