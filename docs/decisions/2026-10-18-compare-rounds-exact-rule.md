# `melian compare` addresses rounds by a stored round ID

Supersedes: [2026-10-15-compare-addresses-revisions-by-head.md](2026-10-15-compare-addresses-revisions-by-head.md)

For plan step 23, phase 1, before any code, revised after the attack on [pull request #148](https://github.com/melian-agent/melian/pull/148).

## What survives from the direction

Problem: once a pull request merges, `melian compare` and `melian findings` cannot reach its stored rounds, because they find a verdict by the revision a range resolves to now. Two rounds at one revision also share one slot, `base..head`. The records for [#111](https://github.com/melian-agent/melian/pull/111), [#113](https://github.com/melian-agent/melian/pull/113), [#114](https://github.com/melian-agent/melian/pull/114), [#116](https://github.com/melian-agent/melian/pull/116) and [#117](https://github.com/melian-agent/melian/pull/117) were written by hand or from a scratch clone, and none feeds `melian compare stats`.

These clauses stand unchanged:

- A stored round is found by what Melian recorded about it, never by the range that made it.
- `melian compare "#N"` gathers the rounds of a pull request, merged or open, and a recurring finding can be adjudicated across them.
- Thread import keeps every rule of [the comparison-sites decision](2026-10-05-comparison-sites.md).
- Until this is built, records after a merge are written by hand.
- How `compare stats` counts a pull request whose rounds sit in several changesets stays [readiness question 3](../readiness-check-questions.md). Whether `--of` may name a recurring ID stays readiness question 4.

## Round identity and numbering

A round begins in the commit that creates an `AdjudicationTask` in `startAdjudication` without attaching to a stored one. That commit mints the round's ID from a counter in a new root document, `melian.rounds`: `<changeset ID>.r<n>`, with `n` counting from 1 in each storage. It maps each revision key to its current round, and each round to the adjudication tasks it owns.

Minting at triage missed rounds: `reviewChangeset` skips triage on some paths, and a new adjudication input replaces the verdict while triage attaches. Every path that writes a verdict:

- Mints: a review whose adjudication input is new; a review that skips triage, such as a mutation-only round, a change no lens covers, or a host with no credentialed model; `--rerun` after a lens failure; a static rerun, `--cold`, a policy-fingerprint change, a verifier rerun, or another tier with the same lenses; a failed adjudication rerun, whose failed round recorded no verdict.
- Keeps the current round: a resume or repeat review that attaches; a dismissal, whose adjudication `recordDismissal` creates, and a repeat dismissal.
- Mints nothing: a review `startAdjudication` finds replaced, which creates no task; the triage commit, which deletes the live verdict and leaves every round's copy alone.

The adjudication commit is the only verdict writer. With `melian.verdicts` it writes the copy, verdict and provenance, of the round that owns its task. A superseded task writes neither. Once a later round is minted, nothing writes an earlier round's copy, so it is frozen. Comparison refuses a round with no verdict, or a current round whose adjudication is undecided, with `notReviewed`, as now.

Each round record holds its base, head, mint time, owned tasks and verdict copy; range mode plays no part. A round number is for display only: within `#N`, members are numbered from 1 by mint time, ties by round ID, and the snapshot keeps the numbers until the next refresh.

A storage written before this change has no `melian.rounds`. Each verdict key `k` there reads as one legacy round, `<changeset ID>.k<first 16 hex digits of sha256(k)>`, with the base and head that `k` names. Reads synthesise them and write nothing. The first commit that touches `k`'s verdict, comparison or round records the legacy round first, with the verdict as it stood. The triage commit's delete counts.

## Writes name one round

`compare` import, `match`, `unmatch` and a range's `adjudicate` each write one comparison in one storage. A round ID names its storage through its changeset ID, resolved only to `<state directory>/<changeset ID>.sqlite`, with the state directory chosen once per command; no other root is searched. Every command that writes accepts `--round <id>`:

- With a range target and no `--round`, the write goes to the current round at the revision the range resolves to, as today.
- With `#N` and no `--round`, the write goes to the one member round at GitHub's head that has recorded a verdict. An undecided round, as a crash and `--rerun` leave, does not count. It refuses, listing the rounds, when there are none or several.
- A `--round` that names a foreign round, or a round not in the state directory, is refused. An ambiguous round is written only with `--round`.

`ComparisonDocument` keys its comparisons by round ID instead of by `base..head`, so two rounds at one revision hold two comparisons.

## Which rounds belong to `#N`

GitHub is the authority on which commits belong to the pull request, and the stored round record on what each round reviewed. Branch names and changeset IDs play no part.

A `#N` command that can reach GitHub reads the pull request through GraphQL: its commit list, every `HeadRefForcePushedEvent`'s before and after commits, `baseRefOid`, and the merge commit if there is one. It pages by `pageInfo.hasNextPage`, never by `totalCount`, which counts every timeline item whatever the filter. A failed page fails closed. Base-change events are not read, since none carries a commit.

GitHub caps a pull request's commit list at 250, so a list of 250 or more may be cut: the command fails closed and names the cap, and `--round` still writes. A null `beforeCommit` is missing: the snapshot records the push, and export says rounds at that head may be absent.

`#N`'s heads are the commits, the force-push commits and the current head. Melian reads `melian.rounds` from every storage in the state directory through detached reads, as stats does. Each round is placed by the first rule that applies:

1. **Its own provenance.** A round whose provenance kind is `pull-request` belongs to its stored repository and number only. Rounds from `melian review "#N"` in `pull-<hash>.sqlite` are members on that record, without a git test. So is a round a publish target for `#N` names: the target records its round ID from now on, and a legacy target's revision is one legacy round.
2. **Exact base.** A range round whose head is one of `#N`'s heads is a candidate. Let B be the merge commit's first parent for a merged pull request, and `baseRefOid` otherwise. A candidate is a member only when its stored base equals `git merge-base B <head>`: then it reviewed the diff the pull request showed at that head. Any other base is foreign, which excludes a delta round, `AGENTS.md`'s mutation round over fix commits, and a round against a stale `origin/main` that saw another diff.
3. **Ambiguous.** A range member whose head's `associatedPullRequests` names another pull request is listed as ambiguous, with the other numbers. A squash-merged parent's rounds, whose heads stay in the child's commit list, and a branch reopened as a new pull request are the cases.

A foreign round is listed with the rule it failed, never written. A commit missing from the clone after fetching, such as a dropped force-pushed head, makes a candidate foreign. Rule 2 needs no range mode, so a legacy round is a member exactly when its stored base equals the merge base. A round against a stacked parent has the parent's tip as base, which `git merge-base B <head>` returns once the parent lands by merge commit; a squashed parent leaves it foreign. Branch and detached rounds are scanned alike, so two at one revision are two members.

The `#N` command stores the result in a new root document, `melian.pull-request-rounds`, in the pull request's own storage, `pull-<hash>.sqlite`. The snapshot holds GitHub's answer, the numbered members, and the foreign and ambiguous rounds with reasons. Export and stats read it offline. Every `#N` command that reaches GitHub refreshes it before writing, and says what changed.

A refresh that would drop a member holding an `#N` adjudication fails closed: it lists the member and the reason, keeps the old snapshot, and writes nothing.

## Thread import's head rule

GitHub places threads at the current head, so `melian compare "#N" --from github` imports into the decided member round at GitHub's current head, or the one `--round` names. With no such round, import refuses and writes nothing. A thread first written on an earlier head stays external-only, with that commit.

## A cross-round adjudication after a crash

`melian compare adjudicate "#N" <id>` writes one record to `melian.pull-request-rounds`, keyed by finding ID, with a round adjudication's fields, history and golden carry-forward. One commit in one storage leaves a crash with nothing or the whole adjudication. This drops the direction's one write per changeset, which had a crash window.

The record applies to every member round in the current snapshot that holds the ID. A round's own adjudication of the same ID, from a range or `--round`, wins when its `at` is later; on a tie, the round's own wins. `adjudicate "#N" <id> --round <id>` writes the round's own record instead.

Precedence by `at` trusts the host clock, and the risk is accepted. The two records sit in different storages, so only a cross-storage counter could order them. One clone writes both, so the clock is compared with itself, and export shows which record applied, so a clock that stepped back is visible.

## Stored shapes

- `melian.comparisons` goes from version 1 to 2, keyed by round ID. The migration maps each version 1 key `k` to its legacy round ID. Its reopen fixture is written by `ac4e8c07`'s code, with comparisons at two keys and an adjudication history.
- `melian.rounds` is new, at version 1. Reopen tests: a storage `main`'s code wrote reads as legacy rounds without a write, and a crash between minting and deciding a round reopens to the same round.
- `melian.pull-request-rounds` is new, at version 1, with a reopen test from SQLite.
- The publish task's target gains a round ID, a version bump with a reopen test from a target `main`'s code wrote.
- `melian.verdicts` does not change.
- `compare export --json` keys its comparisons by round ID.

`melian findings --round <id>` reads a round's verdict copy.

## For the attack

1. A dismissal reaches only the current round, so a frozen round's verdict is final.
2. An adjudication task left pending by `main`'s code has no owning round; it must write the legacy round of its key.
3. A manual retarget, as [#98](https://github.com/melian-agent/melian/pull/98) had, changes B, so earlier rounds read foreign. The rule assumes B never contains the pull request's own commits, under merge, squash or rebase merges.
4. A member that can never return, its commit dropped or its storage deleted, blocks every later `#N` write once it holds an `#N` adjudication. No command withdraws one.
5. Provenance and publish targets admit rounds without a git test, so they are only as trusted as the store.
