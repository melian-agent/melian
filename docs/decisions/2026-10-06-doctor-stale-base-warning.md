# Doctor warns about local main

Supersedes: 2026-10-06-doctor-base-policy.md.

Doctor retains the committed-policy precedence: local origin/HEAD, origin/main, main, then HEAD. It never fetches and still names the chosen ref and commit.

Without a remote base ref, local main may be stale. Doctor warns even when that policy trusts writers and the viewer has write permission. The HEAD fallback continues to warn that the base is unknown. Both warnings leave exit 0. Refresh the local base refs before a rehearsal. Identity and permission reads retain the earlier rules.
