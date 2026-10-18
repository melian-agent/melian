# `melian compare` addresses rounds by a stored round ID

Supersedes: [2026-10-15-compare-addresses-revisions-by-head.md](2026-10-15-compare-addresses-revisions-by-head.md)

For plan step 23, phase 1, before any code, revised after two attacks and Codex's adversarial review on [pull request #148](https://github.com/melian-agent/melian/pull/148).

## What survives from the direction

Problem: once a pull request merges, `melian compare` and `melian findings` cannot reach its stored rounds, because they find a verdict by the revision a range resolves to now. Two rounds at one revision also share one slot, `base..head`. Five records, from [#111](https://github.com/melian-agent/melian/pull/111) to [#117](https://github.com/melian-agent/melian/pull/117), were written by hand, and none feeds `melian compare stats`.

These clauses stand unchanged:

- A stored round is found by what Melian recorded about it, never by the range that made it.
- `melian compare "#N"` gathers the rounds of a pull request, merged or open, and a recurring finding can be adjudicated across them.
- Thread import keeps every rule of [the comparison-sites decision](2026-10-05-comparison-sites.md).
- Until this is built, records after a merge are written by hand.
- How `compare stats` counts a pull request whose rounds sit in several changesets stays [readiness question 3](../readiness-check-questions.md). Whether `--of` may name a recurring ID stays readiness question 4.

## Round identity and numbering

A round begins in the commit that creates an `AdjudicationTask` in `startAdjudication` without attaching to a stored one. That commit mints the round's ID from a counter in a new root document, `melian.rounds`: `<changeset ID>.r<n>`, with `n` counting from 1 in each storage. It maps each revision key to its current round, and each round to the adjudication tasks it owns.

Every path that writes a verdict:

- Mints: a new adjudication input; a review that skips triage (mutation-only, no lens covers the change, no credentialed model); `--rerun` after a lens failure; a static rerun, `--cold`, a policy change, a verifier rerun, or another tier; a failed adjudication's rerun.
- Keeps the current round: a resume or repeat review that attaches; a dismissal, whose adjudication `recordDismissal` creates, and a repeat dismissal.
- Mints nothing: a review `startAdjudication` finds replaced, which creates no task; the triage commit, which deletes the live verdict and leaves every round's copy alone.

The minting commit also deletes the live verdict, provenance and decision at its key, as triage does. Otherwise `melian findings` and `recordDismissal` read the last round's verdict until the new round decides.

The adjudication commit is the only verdict writer, and also writes the verdict and provenance copy of the round that owns its task. A superseded task writes neither. Once a later round is minted, nothing writes an earlier round's copy, so it is frozen. Comparison refuses a round with no verdict, or a current round whose adjudication is undecided, with `notReviewed`, as now.

Each round record holds its base, head, mint time, owned tasks and verdict copy; range mode plays no part. A round number is for display only: within `#N`, members are numbered from 1, legacy rounds first by their head's commit date, then minted rounds by mint time, ties by round ID. The snapshot keeps the numbers until the next refresh.

A storage written before this change has no `melian.rounds`. Each key `k` that holds a verdict or a comparison reads as one legacy round, `<changeset ID>.k<first 16 hex digits of sha256(k)>`, with the base and head that `k` names. A key with comparisons and no verdict, as `main`'s triage delete and failed adjudications leave, is an undecided legacy round. Reads synthesise them and write nothing. The first commit that touches `k`'s verdict, comparison or round records the legacy round first, with the verdict as it stood; the triage commit's delete counts. It reads and records inside the writer's own transaction, against a race. An adjudication task left pending by `main`'s code belongs to its key's legacy round, and overwrites that round's verdict when it settles, as `main` did.

## Writes name one round

`compare` import, `match`, `unmatch` and a range's `adjudicate` each write one comparison in one storage. A round ID names its storage through its changeset ID, resolved only to `<state directory>/<changeset ID>.sqlite`, with the state directory chosen once per command; no other root is searched. Every command that writes accepts `--round <id>`:

- With a range target and no `--round`, the write goes to the current round at the revision the range resolves to, as today.
- With `#N` and no `--round`, the write goes to the one member round at GitHub's head that has recorded a verdict. An undecided round, as a crash and `--rerun` leave, does not count. It refuses, listing the rounds, when there are none or several.
- A `--round` that names a round a rule rejected as foreign, or a round not in the state directory, is refused. An ambiguous or unattributed round is written only with `--round`.

`ComparisonDocument` keys its comparisons by round ID instead of by `base..head`, so two rounds at one revision hold two comparisons.

## Which rounds belong to `#N`

GitHub decides which commits belong to the pull request, and the stored round record what each round reviewed; branch names play no part.

A `#N` command that can reach GitHub reads the pull request through GraphQL: its commit list, every `HeadRefForcePushedEvent`'s before and after commits, `baseRefOid`, and the merge commit if there is one. It pages by `pageInfo.hasNextPage`, never by `totalCount`, which ignores the filter. A failed page fails closed. Base-change events are not read, since none carries a commit.

GitHub caps a pull request's commit list at 250, so a list of 250 or more may be cut: the command fails closed and names the cap, and `--round` still writes. A null `beforeCommit` is missing: the snapshot records the push, and export says rounds at that head may be absent.

`#N`'s heads are the commits, the force-push commits and the current head. Melian reads `melian.rounds` from every storage in the state directory through detached reads, as stats does. Each round is placed by the first rule that applies:

1. **Its own provenance.** A round whose provenance kind is `pull-request` belongs to its stored repository and number only. Rounds from `melian review "#N"` in `pull-<hash>.sqlite` are members on that record, without a git test. So is a round a publish target for `#N` names: the target records its round ID from now on, and a legacy target's revision is one legacy round.
2. **Exact base.** A range round whose head is one of `#N`'s heads is a candidate. Let B be the merge commit's first parent for a merged pull request, and `baseRefOid` otherwise. A candidate is a member only when its stored base is one of `git merge-base --all B <head>` and every such merge base has the same tree: then it reviewed the diff the pull request showed at that head. Merge bases that differ in tree give different diffs, and Melian cannot tell which GitHub showed, so the command fails closed and names the cause; `--round` still writes. Any other base is foreign, which excludes a delta round, a mutation round over fix commits, and a round against a stale `origin/main`.
3. **Ambiguous.** A range member whose head's `associatedPullRequests` names another pull request is listed as ambiguous, with the other numbers. A squash-merged parent's rounds, and a branch reopened as a new pull request, are the cases.

A foreign round is listed with the rule it failed, never written. A commit missing after fetching makes a new candidate foreign.

A force push can hide a head for good, a stated limit that Melian does not reconstruct. Review H1, push H2, then force-push G: the event names H2 and G, and nothing names H1. A range round whose head GitHub no longer lists as a commit or a force-push commit cannot be attributed. Such a round, in a storage that holds a member of `#N`, is listed by export as unattributed, with the count, and stats counts it apart; `--round` writes it. Rounds from `melian review "#N"` are members by provenance and unaffected. The limit is acceptable because Melian's own loop never force-pushes a pushed commit: fixes land as new commits, and a task never rebases.

A fast-forward push makes the head the merge commit, so B is one of the pull request's commits and every round would read foreign. When M^1 is one of `#N`'s commits, the command fails closed and names the fast-forward; `--round` still writes. Only a manual push does this. Rule 2 needs no range mode, so it judges legacy rounds too. A round against a stacked parent has the parent's tip as base, which `git merge-base B <head>` returns once the parent lands by merge commit; a squashed parent leaves it foreign.

The `#N` command stores the result in a new root document, `melian.pull-request-rounds`, in the pull request's own storage, `pull-<hash>.sqlite`. The snapshot holds GitHub's answer, the numbered members, and the foreign and ambiguous rounds with reasons. Export and stats read it offline. Every `#N` command that reaches GitHub refreshes it before writing, and says what changed.

A member that becomes unreachable, its commit collected or its storage deleted, stays in the snapshot marked unreachable, keeping its number and its `#N` adjudications. A refresh fails closed only when a rule now rejects an earlier member, as after a manual retarget: it lists the member and the rule, keeps the old snapshot, writes nothing, and names the command below.

`melian compare refresh "#N" --accept` is the maintainer's way out. It records GitHub's new answer as a new snapshot version, and moves each rejected member to an audited foreign set with the git author, the time, and the rule that rejected it. Their `#N` adjudications stay readable in the history but no longer apply. Earlier snapshot versions are kept.

## Thread import's head rule

GitHub places threads at the current head, so `melian compare "#N" --from github` imports into the decided member round at GitHub's current head, or the one `--round` names. With no such round, import refuses and writes nothing. A thread first written on an earlier head stays external-only.

## A cross-round adjudication after a crash

`melian compare adjudicate "#N" <id>` writes one record to `melian.pull-request-rounds`, keyed by finding ID, with a round adjudication's fields, history and golden carry-forward. One commit in one storage leaves a crash with nothing or the whole adjudication. The direction's one write per changeset had a crash window.

The record applies to every member round in the current snapshot that holds the ID. A round's own adjudication of the same ID, from a range or `--round`, wins when its `at` is later; on a tie, the round's own wins. `adjudicate "#N" <id> --round <id>` writes the round's own record instead.

Precedence by `at` trusts the host clock, an accepted risk: only a cross-storage counter could order two storages' records, one clone writes both, and export shows which record applied.

## Stored shapes

- `melian.comparisons` goes from version 1 to 2, keyed by round ID. The migration maps each version 1 key `k` to its legacy round ID. Its reopen fixture is written by `ac4e8c07`'s code, with comparisons at two keys and an adjudication history.
- `melian.rounds` is new, at version 1. Reopen tests: a storage `main`'s code wrote reads as legacy rounds without a write; an adjudication task `main`'s code left pending writes its key's legacy round; a crash between minting and deciding reopens to the same round.
- `melian.pull-request-rounds` is new, at version 1, holding numbered snapshot versions and the audited foreign set, with a reopen test from SQLite.
- The publish task's target gains a round ID, a version bump. Reopen tests: a target `main`'s code wrote, and a target and a pending publish task written by build pull request 1's own code with two rounds at one revision.
- `melian.verdicts` does not change.
- `compare export --json` keys its comparisons by round ID.

`melian findings --round <id>` reads a round's verdict copy.

## Build plan

About 6,500 changed lines land as four stacked pull requests, each testable alone:

1. **Rounds in the store**, about 2,250 lines: `melian.rounds`, minting, legacy rounds, `findings --round`, and the publish target's round ID, tested through range commands. The round ID lands here so that no stack version writes a target without one once two rounds share a revision.
2. **Comparisons by round**, about 1,300: `melian.comparisons` version 2 with its fixture from `ac4e8c07`, and `--round` on range writes.
3. **Membership**, about 2,100: the GitHub reader, rules 1 to 3, the snapshot and `refresh --accept`, with `compare "#N"` reads, export and the unattributed count. The reader can start beside the first.
4. **`#N` writes**, about 1,050: the default round, cross-round records and thread import.

## For the attack

Accepted: a frozen round's verdict is final, since a dismissal reaches only the current round. A retarget onto another base leaves earlier rounds foreign, as they reviewed another diff, until `refresh --accept` records that. Provenance and publish targets skip the git test; whoever writes the store can forge verdicts anyway. A range round at a head a force push hid is unattributed, never guessed in.

Open: `refresh --accept` trusts the maintainer to read the rejected members it lists; nothing stops accepting a GitHub answer that is itself wrong.
