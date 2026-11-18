# Issue #481: dismiss with a store is all or nothing, and the round chain survives a fresh host

Two fixes on [pull request #575](https://github.com/melian-agent/melian/pull/575), each from a Codex review, and each by a maintainer's ruling of 2026-11-18 given in the coordinator's session.

## Dismiss with a store is all or nothing

Codex's third review found that `dismiss` recorded the dismissal on the host and then wrote its record, so a store that failed left the host dismissed and the store not. The ruling on [issue #395](https://github.com/melian-agent/melian/issues/395) set the order: list the store, and refuse if it cannot be listed; build the record inside the commit, with `supersedes` from that listing; write it, and refuse with nothing recorded if the write fails; only then commit. `eb1229c46` does that, with the new `DismissError` code `storeFailed`, and `d541bd54f` has the CLI name the store it refused on. [The decision](../decisions/2026-11-18-a-dismissal-record-is-written-once.md#when-the-store-fails) records the one gap: a record written before the host's commit fails, which leaves the shared side stricter, and which `dismiss` run again writes with the same bytes.

The tests came first. At `00fdbf1fc`, the list and add failures in `review-records-export.test.ts` rejected with the store's own error, not `storeFailed`, and the commit-failure test resolved instead of rejecting. The CLI test failed on its message. All pass on the fix.

## The round chain survives a fresh host

Codex's fourth review found that a round from a host with no local history of the pull request wrote `before: []`, so the reader lost every earlier round and kept a dismissal whose cited hunk had changed. By the ruling, `06b189da3` has such a host name the store's frontier from the review's one listing, and the reader count a dismissal as nothing when any branch of its chain ends before the dismissal's revision. [The decision](../decisions/2026-11-18-a-shared-reader-remembers-every-cited-hunk.md#a-host-with-no-history-of-the-changeset) says what changed and why, and the round's row in [the identity guideline](../guidelines/identity.md#the-keys-melian-has) says what a match by ID now decides.

The tests came first. At `97e087c2c`, the cut chain and the cut branch of a fork in `recorded-round.test.ts` read `dismissed` where they should read `new`. With the reader fixed alone, the three-host test in `review-records-export.test.ts` lost the dismissal at the third host's round, and both fresh-host writer tests read `before` as `[]`. All pass on the fix.

## Mutants

Each pass's mutants came from `melian mutants list <range> --claims-in <file> --json --all`, saved beside this entry. A scratch runner applied each by its position, checked the text it replaced, and ran a named test alone, which passed unmutated first and collected exactly one test.

- The round walk of `a0b8f273a`, over `6a06c0449...a0b8f273a` in `recorded-round.ts`: 68 listed, 64 generated. 61 killed at `a0b8f273a`; `00fdbf1fc` added tests that killed two more; one is equivalent, a walk that visits a round twice, which adds no hunk. In `2026-11-18-issue-481-round-walk-mutants.json`.
- The store failure, over `00fdbf1fc...c6a12537b` in `dismiss.ts`, `errors.ts` and `commands.ts`: 40 listed, 34 generated, all 34 killed at `c6a12537b`. In `2026-11-18-issue-481-store-failure-mutants.json`.
- The round chain, over `97e087c2c...06b189da3` in `recorded-round.ts` and `review.ts`: 30 listed, 29 generated. 25 killed at `06b189da3`. The four in `predecessors` that survived fell at `e70e9f44a` to two new tests: a fresh host names no round of its own revision, and a host with history names only its previous revision's rounds beside another branch. In `2026-11-18-issue-481-round-chain-mutants.json`.

Timing: gate 2 × 15 min; codex 1 × 14 min; mutants 3 × 45 min; wait 1 × 20 min for a ruling.
