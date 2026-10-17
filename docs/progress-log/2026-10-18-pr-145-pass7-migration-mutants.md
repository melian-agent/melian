# Prove the remaining publication migration branches

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 7, adds version-1 pending and completed publication fixtures.
Unchanged producer code at `ef99429f` recorded both snapshots through fake GitHub and fake models.
SQLite reopen tests check the whole upgraded document before and after a persisted version-9 write.
The pending test requires evidence conversion; the completed test requires migration to leave its absent pending round alone.

The installed Stryker instrumenter enumerated 17 mutants across provider line 463 and publication lines 181 and 185.
All were applied alone and restored. Twelve fail; five are equivalent.
Seven evidence-branch mutants fail the new version-1 reopen tests.
Two reply-branch mutants fail the existing version-2 producer-fixture reopen test.
Three provider mutants fail existing ownership tests.

The four migration equivalents repeat conversions that preserve newer stored data.
Evidence arrays already have the current shape from version 2 onward.
From version 3, reply keys include a thread, while resolution keys remain bare finding IDs through version 8.
Repeating reply rekeying finds no resolution at a modern reply key and preserves it.
The provider equivalent removes optional access after an earlier check already rejected a null review author.

`tmp/orphan-thread-mutation-inventory.md` appends every exact replacement and test log.
`tmp/orphan-thread-pass7-report.md` records validation and the nine cold-round finding IDs proposed for dismissal.
Production behaviour and document versions stay unchanged. This fix pass leaves the implementation plan unchanged.

The restored focused run passed all 174 tests across seven suites.
The whole sandbox gate exited 1: 4,826 passed, 53 skipped and four failed.
All four failures require the process table denied by the sandbox; three more process tests skipped automatically.
No timeout or other failure remained. The host still needs the whole gate after this pass.
