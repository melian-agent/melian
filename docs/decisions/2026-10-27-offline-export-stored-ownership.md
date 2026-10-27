# Offline pull request export follows stored ownership beyond its snapshot

Amends: [the exact-round decision](2026-10-18-compare-rounds-exact-rule.md), [comparisons by round](2026-10-21-comparisons-by-round-as-built.md), and [unattributed export scope](2026-10-27-pull-request-unattributed-export.md).

Problem: a membership snapshot is the last GitHub and Git attribution answer, not the authority over later stored ownership. After snapshot 1, a new push can produce round 2 through `review "#N"` and explicit comparison import. Export previously hid round 2 until another refresh, including its comparison and adjudication history.

Core owns one pure query, `PullRequestMembership.storedOwnership`. It returns true for this pull request, false for another owner or incomplete pull-request provenance, and undefined when Git attribution is needed. Pull-request provenance takes precedence over publication. Range provenance permits publication ownership. Repository identity is case-insensitive; the pull request number is exact. This query performs no Git or network operation, and both classification and export use it.

With a snapshot, offline export includes saved members and every conclusively owned round found across the selected state directory. New unknown candidates stay excluded. A missing candidate does not invalidate a saved member or its store. Raw unattributed records remain eligible from the own pull store and stores holding either saved members or newly owned rounds. They keep their raw revision identity. Foreign-only stores stay excluded.

If a saved member now has explicit foreign ownership, export refuses with `MembershipError` before rendering or writing a destination. It directs the maintainer to refresh and then use `--accept` if the refresh reports a rejection. Export cannot silently retain or remove that member and bypass the acceptance audit.

Without a snapshot, compatibility reads remain confined to the own pull store. Raw records and attributed records with true or unknown ownership remain readable. Explicitly foreign attributed records are excluded: a filename cannot override provenance or publication.

Export never changes the saved snapshot or history, assigns new membership numbers, or creates a snapshot version. Saved attributed members retain their order; new owned attributed records follow in round-ID order. Raw records keep their existing order. When the selected entries actually add records beyond the snapshot-only selection, stderr names the saved version and the refresh command. Markdown also labels the snapshot's stored time and says the additional records have no snapshot numbers. A candidate without an added export record causes no warning. The notice also covers raw-only additions and makes no claim about their timestamps.

JSON retains its existing fields, with membership and history exactly as stored. Collision refusal, lazy Markdown rendering and final per-line control escaping still apply. Both stdout and `--out` receive the complete record; warnings go to stderr after successful output. No schema, namespace, aggregate-score rule or build-4 write routing changes.
