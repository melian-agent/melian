# A delta round reviews the change since the last reviewed head, and only a full round approves

Amends: [the delta decision](2026-10-15-delta-re-review.md), its open questions, which this file answers
Amends: [review identity](2026-10-03-review-identity.md), the key of a delta round's tasks, verdict and sightings
Amends: [review attachment](2026-10-03-review-attachment.md), which task a delta round attaches to
Amends: [the rounds decision](2026-10-18-compare-rounds-exact-rule.md), a round's scope, the round `findings` and range writes address, and rule 2's exclusion of a delta round
Amends: [mutation reruns, as built](2026-10-16-mutation-reruns-later-changes.md), the lines a delta round mutates and its partition

For plan step 24, before any code. It must be attacked before a build starts.

## Problem

Every round reviews the whole pull request again, whatever the fix pass changed. On 2026-10-22 and 2026-10-23, every fix pass on pull requests [#162](https://github.com/melian-agent/melian/pull/162), [#165](https://github.com/melian-agent/melian/pull/165), [#167](https://github.com/melian-agent/melian/pull/167), [#168](https://github.com/melian-agent/melian/pull/168), [#171](https://github.com/melian-agent/melian/pull/171), [#172](https://github.com/melian-agent/melian/pull/172) and [#174](https://github.com/melian-agent/melian/pull/174) was followed by a full round of 15 to 70 minutes. [Pull request #174](https://github.com/melian-agent/melian/pull/174) took five rounds of about 35 minutes for fixes of under 50 lines each. A full round also samples, so it can miss the few lines that changed.

## Choice

`melian review <range|#N> --delta` asks for a delta round. Melian picks the round it builds on, the anchor, from its own store. A delta round's lenses review the diff from the anchor's head to the new head, with the pull request's file list and the head as read-only context. Findings from the anchor carry to the new head when the delta left their lines alone. A finding whose lines the delta changed is judged again. Deterministic checks run over the whole range; the mutation check mutates the delta's lines only.

A delta round never passes. Its verdict carries a provisional record, so it reads `not reviewed`, exits 2, and publishes `melian/review` as `error`. Only a full round can approve. Without `--delta`, every round is full, as today.

Why: the convergence rule already says the last round before the queue is a full one. Making a delta round unable to approve enforces that rule in the store, not in the coordinator's script. [Mutation reruns](2026-10-16-mutation-reruns-later-changes.md) set the precedent: "Reuse while iterating, final run cold." A delta round is the same bargain for lenses.

## The anchor

The anchor is the newest decided round in the changeset's storage that meets every rule below. When none does, the review runs in full and prints the reason of the newest round it rejected. A fallback is always to a full round, never to a delta of narrower scope.

1. Its base is the new revision's base, the exact commit. A merge of `main` into a branch moves a three-dot range's merge base, so it runs in full.
2. Its head is a proper ancestor of the new head: `git merge-base --is-ancestor <anchor head> <head>` exits 0 and the heads differ. Any other exit, as after a force push or a rebase, runs in full. When a decided round already sits at the new base and head, there is nothing to review: `--delta` refuses with "round rK already reviewed this head".
3. `git rev-list --merges <anchor head>..<head>` is empty. A merge commit in the delta brings in work its author did not write as a fix, so it runs in full.
4. Its chain roots in a full round at the same base. A delta round records its anchor and its root, the full round its chain started from.
5. Every lens record in the anchor's verdict ran, or was skipped with leave. A lens that failed or that a budget ended left findings unread, so carrying from it would hide them.
6. The root's review identity equals the new review's: tier, policy source commit, each selected lens's `name@version`, the plan fingerprint, the override lineage, and the writer leave (`writer` or `reviewer`). The selection a full round would make at the new head equals the root's.
7. The delta touches no policy file, as `Revision.policyFiles` lists them, and no standards file the root's lenses read, as its run details record. A local review can read policy from the worktree, so a changed policy file changes the policy in force.
8. The delta changes at most 1,000 lines, added plus removed, and at most half of the full range's changed lines. Past either, a delta round saves little and samples less. The 1,000 is `review.delta.maxLines` in the base's `melian.yaml`; the half is fixed.
9. Every check record in the anchor ran, was provisional, or was skipped with leave. A `static.mutation` or verification record that failed, hit `toolFailed`, timed out, or was skipped as untrusted left the anchor's judgement incomplete, so the round runs in full.
10. The delta touches no lockfile, `package.json`, `tsconfig*.json`, Vitest configuration or test setup file. Each changes what a test or a tool does across the whole range, not only in the delta's lines.

Rule 1 also covers a pull request whose base branch moved: its provider-fetched base differs, so its first round after the move is full.

The anchor is chosen at intake and fixed in the round's key, so a resume after a crash builds on the same anchor whatever has been decided since.

## Round identity and attachment

A full round keeps the key `<base>..<head>`, unchanged. A delta round's key is `<base>..<head>@<anchor round key>`, where the round key is storage-local, `r<n>` or a legacy `k<hex>`. Example: `9f3c..e1a7@r3`.

A round's key comes from one method over base, head and scope; no caller builds `${base}..${head}` for a round. Problem: `revisionKey()` has 54 call sites, and some build the key by hand, such as `RoundWriter.preserve`'s legacy marker, which reads `revisionKey(round)` from a round's base and head, and the publisher migration in `packages/pipeline/src/publish.ts` at line 583. Each would read a delta round as the full round at its base and head. Solution: every key for a round, a task, a sighting or a verdict goes through the one method, and the build routes all 54 sites through it before any delta round is written.

A key containing `@` must carry a delta scope, and adjudication refuses a key and scope that disagree. A dropped scope must never read as a full round.

The delta key replaces the revision key everywhere a delta round writes: the review index entry and its lens, verification and adjudication tasks, the findings document's sightings and verifications, the check run, the live verdict, and the round. So a delta round and the full round after it, at one base and head, never attach to each other's tasks or read each other's sightings. A repeat `--delta` with the same anchor attaches as a repeat review does today. A newer decided round at an ancestor gives a new anchor and so a new key.

Each `melian.rounds` record gains an optional `scope`: `{ kind: "delta", anchor, root, since }`, with `since` the anchor's head. A record without it is a full round. `melian.rounds` rises to version 2, so an older Melian refuses the storage rather than read a delta round as full. A version-1 document reads unchanged as full rounds.

Minting, keeping and freezing follow [the rounds decision](2026-10-18-compare-rounds-exact-rule.md), per key. A dismissal re-decides only the round `melian findings` shows, below; every other round's copy stays frozen.

A full round retires every delta round at its base and head. Problem: the keys are apart, so a delta that a crash left pending could resume after a full round passed, report a blocker, and stay hidden behind the full round's `success`. Solution: the commit that mints a full round at `<base>..<head>` removes from the review index every delta entry whose key starts `<base>..<head>@`, so their adjudications record no verdict, as [review attachment](2026-10-03-review-attachment.md) already rules for an adjudication the index no longer names. The review then aborts their tasks before it waits, as triage's replacement does. A delta round refuses to start at a base and head where a full round has been minted, decided or not. The check that refuses `--delta` and the delta's index entry commit in one transaction, the one minting a full round writes. So no delta round decides at a base and head after a full round was minted there.

What `melian findings <range|#N>` shows: the full round at the revision's base and head when one is decided, else the newest decided delta round there. Its first line names the scope: "Delta round r5 since e1a7 (anchor r3, full root r1)". JSON adds `round: { id, scope, anchor, root, since }`. `--round` reads any round, and `--rounds` lists the scope beside each.

What `melian compare` writes: a range write with no `--round` goes to the round `findings` shows. A delta round stores the pull request's base and head, so rule 2 of the rounds decision makes it a member of `#N` like any round at that head. The rule's words "which excludes a delta round" assumed a delta stored its anchor's head as its base; that no longer holds, and they are withdrawn. Export and stats label each member's scope. A carried finding counts once per pull request, at the round that first sighted it, so carrying never adds a Melian finding to recall. A carried finding's ID can be renumbered at a later head, when the delta inserts an identical snippet earlier in its file. A later round's finding with the same file, rule and normalised snippet as a carried one, differing only in occurrence, therefore counts as the same finding. With `#N` and no `--round`, a decided full round at the head is chosen over delta rounds there.

## Carried sightings

The carry reads the anchor's own sightings and verifications at the anchor's key, one per producer, never its merged verdict. Problem: a verdict merges reports into one speaker and keeps only part of the others, so a carry built from it could not resolve each report on its own, and a lens speaker merged with a stricter mutation report could lose that report's block. Solution: the carry copies the sightings of the producers the anchor counted, its selected lenses and `static.mutation` at the version its record names, inside the commit that creates the delta lens task, and only while the anchor is still the current round at its key. A later round at that key makes the delta choose its anchor again, under a new key. Lens sightings carry. A mutation survivor's lines are mutated again, below, so the delta's run decides them and its sighting does not carry. Guardrail, static, decision-model and policy sightings do not carry either, because their checks run again over the whole range; a defect a lens and a static check both reported carries its lens report, and the rerun decides the static one.

Git maps each location from the anchor's head to the new head: Melian diffs the two with the review's own diff flags and rename detection, and moves a line by the hunks before it. Every location a finding cites at head counts, its own and each evidence location's. A base-side evidence location names the unchanged base and does not move. Each carried sighting falls into one of two cases:

- **Untouched**: no cited line overlaps a delta hunk's old lines, and no insertion falls inside a cited range. It carries to the new head with its lines moved, its file renamed where git says so, and the anchor's verification copied beside it.
- **Changed**: a cited line overlaps a delta hunk, or git says its file was deleted. It is re-judged, as below. A deleted file is never gone by itself: a heavily edited rename reads to git as a delete and an add.

A changed location maps to the first new-side line after the hunk it overlapped, or to the file's last line when no line follows. That covers a moved block and a pure deletion. No carried finding is resolved by the carry; only a lens's refutation or the verifier's drops one.

A carried finding keeps its ID, its producer, its severity as reported, and its lifecycle, so a dismissal stays dismissed. Melian computes its cause and trigger again against the full range at the new head, through `Revision.classifyCause`, so the dismissal reopen rule compares the right hunk. The carry never lowers, drops or reopens a finding by itself; only a lens, the verifier or the reopen rule does.

A carried sighting is stored at the delta key under its own producer with the prefix `carried/`, as `carried/lens.correctness@<version>@careful`, beside its copied verifications. It keeps its source check and rule, so adjudication resolves it by its own path, and a delta lens's new sighting never replaces it. The delta round's merge step treats an untouched carried sighting as one more sighting: when a delta lens sights the same ID, the highest severity wins, so an untouched finding never loses to a weaker new one. Its sighting records `carriedFrom: <anchor round ID>`, and the findings document rises to version 11.

Re-judging reuses escalation's hand-off. Every carried finding whose lens runs in the delta is handed to that run, as changed findings are, because a fix made elsewhere, such as a new test, can answer it. The run is given each finding with its file, lines and rule. The lens may restate it, by the same ID or the same file and rule on overlapping lines. It then counts once, and keeps the stricter of its carried and restated severity; only a refutation through the trust floor, or the verifier, lowers it. The lens may refute it by ID, which drops it. If the lens does neither, an untouched finding stays carried with the anchor's verification, and a changed one is stored as carried at its mapped line for the verifier to judge against the new head. A changed finding whose lens does not run in the delta goes straight to the verifier. A refuted changed finding, from either, follows the existing trust floor.

## The inputs

**Lenses.** A lens runs when its paths match a file the delta changes, by old or new path. It runs at the root's level or its default within its band, whichever is higher. Triage never runs on a delta, so the author's fix cannot steer a lens to `quick`. Escalation applies as usual.

The lens prompt renders the delta's diff as the change under review, and the full range's file listing, with each file's status, as context. The read tools are unchanged: `read_file` and `search` read the new head, or the base with `revision: base`.

Cause is classified against the full range, base to new head, never against the delta. A fix that reverts a line to its base text leaves base code, so a finding there is `pre-existing`. A delta finding whose cause evidence sits in the delta's lines is `affected` only when those lines are also changed lines of the full range.

**The verifier** judges the delta's new sightings and the changed findings that reach it. Untouched carried findings keep the anchor's judgement.

**Static checks** run as a full round runs them, on base and new head over the whole range. They are deterministic and take minutes, not the lenses' half hour. The check run's identity includes the delta key, so the full round after it runs them again; that costs minutes and saves a second identity rule.

**`static.mutation`** mutates the delta's production lines and the lines of every carried mutation survivor: the lines the delta adds or edits that are also changed production lines of the full range, and each anchor survivor's line moved by git. Its record is `provisional`, with the reason "mutated N line(s) changed since <anchor head>; a cold full run decides approval". Its survivors are findings as usual. A delta run reads the partition as any run does, but never publishes its own: its report covers part of the pull request, and storing it would make the next full run repeat mutants the anchor's partition already judged.

**The walkthrough** does not run on a delta round. Its ledger shows "The walkthrough comes with the next full round."

## The status

A delta round's adjudication adds one check record, `review.delta`, with the status `provisional` and the reason "delta round since <anchor head> (anchor rK): lenses read the change since that head; N finding(s) carried; a full round decides approval". It comes from the adjudication input's scope, which Melian set at intake. Nothing the head writes reaches it. A provisional record leaves the review not reviewed, as the mutation check's does: the verdict is never `passed`, the exit code is 2, and the published status is `error`. A blocking finding still shows as blocking in the verdict.

`melian publish "#N"` publishes the full round at the pull request's base and head when one is decided, and otherwise the newest decided delta round there. A delta round is published under its own key, so publication diffs it against the round published before, and its carried findings stay open with their threads. The body and ledger say it is a delta round, name the anchor head, count the carried findings, and say a full round decides approval. The status description names `review.delta`, as a provisional mutation check is named, and carries no base suffix, since only `success` does.

The merge-group job, `melian status merge-group`, is unchanged. It copies only a writer's `success`, so a head whose newest `melian/review` came from a delta round fails its group.

What can approve: a full round, cold where the tier holds `static.mutation`, at the pull request's current base and head. A delta round on top of a passing full round, with no change outside the delta, cannot. Its lenses read only the delta, and its mutation run is partial, so its pass would rest on a sample.

## Which rounds run in full

- Every round without `--delta`, which is the default.
- `--cold`. With `--delta`, it is refused as a usage error: a cold run is the round that decides approval.
- The first round of a changeset, which has no anchor.
- After a base change, a rewritten history, or a merge commit in the delta, by the anchor rules. The same holds after a policy, standards, dependency, configuration or test setup change, or a change of review identity or selection. It also holds when the anchor has a failed or ended lens or an incomplete check, and when the delta is past its bound.

The coordinator still marks the last round, by leaving out `--delta` and adding `--cold`. The status enforces it: a pull request whose head was last reviewed by a delta round cannot pass `melian/review`.

## Failure modes

- **A force push or rebase.** The anchor's head is no longer an ancestor, so the round runs in full and says the history was rewritten.
- **A merge of `main`.** The base moves, or the delta holds a merge commit, so the round runs in full and names the cause.
- **A delta past its bound.** The round runs in full and names the delta's size and the bound.
- **A crash mid-round.** The carried sightings are written in the commit that creates the delta lens task, so a crash leaves both or neither. The key fixes the anchor, so a resume attaches to its own tasks. A crash between minting and deciding leaves an undecided round, which `publish` and `findings` skip, as they skip one today.
- **A detached worktree.** Its range names a bare commit, so each head is its own changeset, with no earlier round in its storage. `--delta` there runs in full.
- **A carried finding whose ID would change at the new head.** An identical snippet the delta inserts earlier in the file renumbers occurrences. The carried finding keeps its ID; the next full round sights it under the new one, and the old one resolves, as across heads today. Comparison counts the two once, by file, rule and normalised snippet.

## Stored shapes

- `melian.rounds` version 2: `scope` on a round. Reopen test from a version-1 document `main`'s code wrote.
- `melian.findings` version 11: the `carried/` producers and `carriedFrom`. Reopen test from a version-10 document.
- The lens task, version 5, and the adjudication task, version 6, gain the delta scope in their input. An input without it is a full round. Reopen tests from tasks each earlier version left pending.
- The checks run identity gains the delta key and mutated ranges; the checks document's version rises with it.
- `melian.verdicts` does not change: `review.delta` is an ordinary check record.

## What it saves

Every pull request still runs two full rounds: the first, and the cold final round before the queue. Static checks run over the whole range in every delta round too. So delta rounds save time only on a pull request with three or more rounds.

On [pull request #174](https://github.com/melian-agent/melian/pull/174), five rounds took about 175 minutes. Running rounds 2 to 4 as deltas would have saved about 60 to 75 of them. Rounds 1 and 5 stay full, and each delta still pays for static checks and the verifier.

The risk is late. A defect in unchanged code that the first round missed surfaces only at the final full round, and a fix then costs another full round. Today any round can find it.

## Given up

- A delta round re-reads nothing outside the delta, so a defect the anchor missed in unchanged code waits for the last full round. That is no worse than today, where a full round samples too.
- Static checks run twice over the range in a loop that ends in a full round.
- A carried finding keeps the anchor's verification, even when the delta changed code that finding's guard depends on elsewhere. The delta's lenses may sight it afresh; otherwise the last full round judges it.
- The 1,000-line bound and the half rule are guesses. Step 24's build records each delta round's size and time in the progress log, and the maintainer may tune them.

## For the attack

Trust and blocking rules, each to be attacked before any build:

1. A delta verdict can never be `passed`, and its `review.delta` record comes only from Melian's intake.
   A key containing `@` must carry a delta scope, and adjudication refuses a key and scope that disagree.
2. `publish` takes a decided full round over any delta round at one base and head; minting a full round retires every delta round there; `--delta` refuses where a full round was minted or a round already reviewed the head. The refusal and the delta's index entry commit in one transaction, the one minting a full round writes.
3. Each anchor rule, 1 to 10, falls back to a full round.
4. The carry: per-producer lens sightings copied while the anchor is current; untouched or changed, with a deleted file changed, never gone; locations mapped by git, cause recomputed against the full range; every carried finding whose lens runs is handed to it.
5. A carried finding is never lowered, dropped or reopened by the carry. A restated finding keeps the stricter of its carried and restated severity; only a refutation through the trust floor, or the verifier, lowers it.
6. Cause comes from the full range, never the delta.
7. A lens runs at the root's level or its default within its band, whichever is higher, and triage does not run.
8. `static.mutation` mutates the delta's production lines and every carried survivor's line; the run is provisional and publishes no partition.
9. A delta round is a member of `#N`; with no `--round`, a decided full round at the head wins; a carried finding counts once, a renumbered one included.
10. A round's key comes from one method over base, head and scope; no caller builds `${base}..${head}` for a round.
