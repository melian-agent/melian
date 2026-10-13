# Triage records keep their reachable history

Supersedes: [the snapshot-test decision](2026-10-12-repository-tests-read-the-commit-under-test.md), for triage history and scratch history only.

Problem: comparing questions.json with HEAD lets a committed rewrite replace both the record and its baseline. Rewording a question under version 1 then passes.

Choice: compare every version key with every earlier record reachable from HEAD. Convert the original questionSet/fingerprint shape to the same version map. A version may be added, never changed or deleted. Unreadable, empty or shallow history fails closed. A single record commit passes only when it added that file.

The mutation scratch repository carries reachable history, without remote refs. Decision-index tests still check every active title, the active count and byte headroom at HEAD. Those assertions depend on the tree being indexed, not an immutable historical value.

[Pull request #98](https://github.com/melian-agent/melian/pull/98) restores this historical invariant.
