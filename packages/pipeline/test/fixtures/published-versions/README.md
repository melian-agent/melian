# Recorded publication versions

Each `vN.json` holds verbatim `PublishedDocument` snapshots written by the source commit in `writtenBy`.
The source trees came from `git archive`, with their own unchanged lockfiles installed through `npm ci`.
The sandbox refused `git worktree add` when it tried to create the scratch worktree's Git metadata.
Only a recording test was added to each archived tree; production code stayed unchanged.

| Version | Source commit | Recording |
| --- | --- | --- |
| 1 | `3494ee887f0ad3ee4edefdcc1656debebba08c01` | Last main commit before version 2 |
| 2 | `782f7f875d6ef1933969a88d9fe8b677f0cedcef` | Last main commit before version 3 |
| 3 | `63a8710863da460a9e96f89ba5accc5d59573e6c` | Last main commit before the ledger |
| 4 | `eb2fa24944651fe465927144e1678c28b201db04` | Last ledger-branch commit before version 5; version 4 never reached main |
| 6 | `5c3a2a1db614989d90e41ab629e5d59d7b8c126e` | Last main commit before publisher attribution |
| 7 | `748dfe37f634550f9aba8b8886aefa4e09984dab` | Last main commit before version 8; dismissals and writer trust off |

The recorder used the historical GitHub scenario helpers, fake models and `fakeGitHub`.
It reviewed an inline finding and a finding outside the diff.
Version 1 gives the latter a single cause location; later versions already store evidence lists.
It captured a refused review's pending round, its successful retry, and a later revision that resolved the inline finding.
Version 7 instead records a dismissal, a refused dismissal review, its retry, a changed dismissal reason with an owed reply, and the eventual reply.
Its writer trust is off, with the historical fake publisher's login and permissions retained.
The historical build answers a changed dismissal reason without creating another review, so the recorder refuses its reply to capture the owed state.
No live model or GitHub request ran.

`vN-expected.json` holds independent version-9 expectations, specified without calling a migration.
Version 1 converts evidence in both pending posts and verdicts.
Older replies gain their thread key, resolutions gain their ID and thread key, and legacy publications gain trusted-writer attribution.
The test writes the recorded snapshots through their old document token into SQLite, closes it, then reads through head's token.
It compares the complete upgraded value, writes it at version 9, and checks it again after another reopen.

The recording tests, install logs, mutation logs and inventory are retained with the lane report under `tmp/m2/scratch-published-v1/` in the main checkout.
