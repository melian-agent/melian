# `melian/review` on merge-group commits is copied from each pull request's head

Choice: a workflow on `merge_group` runs `melian status merge-group` from the base's build. It finds every pull request in the group, reads `melian/review` on each one's head, and posts `melian/review` on the merge-group commit with the job's `GITHUB_TOKEN`. It posts `success` only when every head's latest status is `success` from a writer, for a reviewed base the group's base contains. Otherwise it posts `failure` and names the pull request.

Why: a required status must pass on the merge-group commit, and nothing else can put it there before milestone 3.

## The problem

`main`'s ruleset, 24413134, runs a merge queue and requires the three `check (…)` jobs, which `check.yml` also runs on `merge_group`. The maintainer will add `melian/review`. `melian publish` posts it on the pull request's head; on [pull request #164](https://github.com/melian-agent/melian/pull/164) the maintainer's user token set `success` on `7abe2a6d`. The queue then tests a new merge commit. No one posts `melian/review` there, so the queue waits out its 30-minute timeout and ejects every pull request.

## Options

- **(a) Copy the head's status in a `merge_group` job.** Chosen.
- **(b) `melian publish` posts on the merge-group commit too.** It cannot: it runs locally, before the group exists.
- **(c) Require the check for pull requests only.** GitHub offers no such option. Its merge-queue documentation says pull request and queue checks "are coupled and configured under branch protection rules or rulesets", and the ruleset's `required_status_checks` takes a context and an optional `integration_id`, nothing per event.
- **(d) A required workflow pinned to a reviewed ref.** A pull request could not edit it, but the rule is organisation-level, which needs GitHub Team; `melian-agent` is on the free plan.
- **(e) Pin `melian/review`'s expected source to GitHub Actions.** That would reject the maintainer's head status, which a pull request needs before it can be queued.

## The design

A new workflow, `.github/workflows/melian-review-group.yml`, runs `on: merge_group: types: [checks_requested]` with `permissions: { contents: read, pull-requests: read, statuses: write }` and `timeout-minutes: 5`. It checks out `merge_group.base_sha`, not the group commit, with `fetch-depth: 0`, because a depth-one checkout lacks the history the walk and the ancestry check read. It installs and runs `melian status merge-group --head <head_sha> --base <base_sha>` from that build. The gate's logic is main's.

The command asks two authorities and requires them to agree:

1. Git. Walk `base_sha..head_sha` by first parent. Every commit must have exactly two parents, its first parent the previous link, ending at `base_sha`. Its second parent is a pull request head. The queue's merge method is `MERGE`; any other shape fails closed.
2. The merge queue. GraphQL `repository.mergeQueue(branch: "main").entries` lists `pullRequest { number headRefOid }`, `headCommit` and `baseCommit`. A link's entry is the one whose `headCommit` is that merge commit, and its `headRefOid` must equal the merge commit's second parent. The first entry's `baseCommit` must equal `base_sha`.

The links are judged by position:

- The last link must equal `merge_group.head_sha`. Its entry is the group's own pull request.
- An earlier link passes if it matches an entry's `headCommit` or is already an ancestor of current `main`. Problem: under ALLGREEN an earlier entry can merge and leave the list while a later group's job runs. Example: entry 1 lands, and group 2's walk still has two links from its old `base_sha`. An exact match on the leading entries would fail group 2 and eject an innocent pull request, on every rerun. Solution: a link that has landed passes.
- A link that passes neither test fails the walk.

The job posts `failure` only when the failing link is the group's own pull request. When an earlier link fails, it posts nothing: that link's own group ejects it, and a `failure` here would eject the innocent pull request behind it. A group whose job posts nothing waits out the queue's timeout, which also ejects. The job retries a failed API read once before it counts the read as failed.

A probe on [pull request #164](https://github.com/melian-agent/melian/pull/164) confirmed that the queue is readable while checks run, and that `headCommit` is the group commit, for a group of one. Positions 2 and up are unproven. The build confirms them on a real queue, read-only, and fails closed until it has.

For each head, the command reads `GET /commits/{sha}/statuses`, newest first, and takes the first `melian/review`, never an older one. That status counts only when all of these hold:

- its state is `success`;
- its creator is a `User`, not a bot, so a status the job itself posted never feeds another copy;
- the creator has write, maintain or admin permission now; a refused `/collaborators/{user}/permission` read fails closed;
- its `target_url` names this repository's pull request with the entry's number, so a head reviewed for another pull request does not lend its status;
- its description carries the reviewed base's full SHA, and `git merge-base --is-ancestor <reviewed base> <base_sha>` succeeds. A missing or unparseable SHA fails closed.

The last rule binds the status to the range it reviewed. Problem: a status names a head, not a range. Example: a stacked child reviewed against its parent keeps `success` when it is retargeted onto `main`, and the new range can hold rebased parent commits nobody reviewed. Solution: `melian publish` writes the reviewed base's full SHA into the status description, which still fits GitHub's 140 characters, and the job requires that base to be an ancestor of the group's base. This design does not introduce the gap, since the same status already lets the head into the queue; the same rule could later gate the head.

The posted status names the pull requests and links to the run. A status belongs to a SHA, and a push removes a pull request from the queue, so the head check is also the stale-head check.

## Trust

Anyone with `statuses: write` can set any context on any commit: a writer's token, an installed app, or the `GITHUB_TOKEN` of a workflow on a branch in this repository. A fork's run gets a read-only token.

So a writer can post a false `melian/review` on a merge-group commit, as they can on a head today. [Writers are trusted](../design.md#writers-are-trusted) by decision, and the job adds no actor who could not already forge the gate.

It adds one path easier to take by accident. A `merge_group` run uses the group commit's workflow file, so a pull request that edits it changes the gate judging its own group. Running the logic from `base_sha` narrows that to the YAML. The root `melian.yaml` adds `.github/**` to `policy-change-review.files`, so an edit, addition or rename of any workflow or action draws a notice at the analyser severity, P1. It resolves to `block` and fails the head's status, as [step 28's rule](2026-10-17-acknowledge-status-exact-rule.md) sets out. The base copy of `melian.yaml` decides, so the pull request cannot strip the glob. Before the glob, nothing under `.github/` drew a notice.

The residual risk stays within writer trust. A `pull_request` workflow on a branch in this repository can request `statuses: write`, because the repository's `read` default does not cap an explicit `permissions` key. It can then post a newer `success` on its own head, from `github-actions[bot]`, over the notice's `failure`. The copy job's bot rule rejects that status, but the same pull request can also rewrite the group's YAML, so a deliberate writer gets through. An accidental one does not.

The copy proves the job's identity, not Melian's: a run of this repository's workflow found a writer's `success` on each head. The head status proves no more today.

The job cannot check the signed review marker. `melian publish` signs each marker with HMAC-SHA256 under the changeset's publisher secret, 32 random bytes generated once and kept in Melian's local storage under the git common directory (`packages/pipeline/src/publish.ts`). The secret never leaves the maintainer's machine, so no workflow holds it. An Actions secret would add nothing: the signer is the trusted writer, and a group run, whose workflow the pull request can edit, reads repository secrets.

Residual risk: a writer can pass the queue without a Melian review. It closes in milestone 3, when the GitHub App posts both statuses and the ruleset names the App as `melian/review`'s expected source. The App must then post on merge-group commits itself, since a status from `github-actions[bot]` will no longer count.

## Failure modes

- **A pull request without a status.** The job posts `failure`, naming the pull request and its head, so the queue ejects it at once rather than after 30 minutes.
- **A stale head.** A push removes the pull request from the queue; a head whose latest status is not `success` fails.
- **A retargeted head.** A status whose reviewed base is not an ancestor of `base_sha`, or that names no base, fails.
- **A group of several.** Each entry's group gets its own `merge_group` event. A group fails on its own pull request; when an earlier link fails, the job posts nothing and leaves that link's group to eject it.
- **A timeout or an API error.** The job retries a failed read once, then posts `failure` with the reason. A job that dies silently leaves the 30-minute timeout, which also ejects.
- **`trust.writers: false`.** The head carries `error`, so every group fails, as the policy intends.

## The ruleset change

In ruleset 24413134 the maintainer adds one context, with no `integration_id`, and the bypass actor:

```json
"required_status_checks": [
  {"context": "check (22)"}, {"context": "check (24)"}, {"context": "check (26)"},
  {"context": "melian/review"}
],
"bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request"}]
```

Actor 5 is the admin role. The workflow lands on `main` first, or the next queued pull request times out.

## The admin bypass

When both model providers are out, no head gets `success`, and the job fails every group. The bypass does not enter the queue: the maintainer merges the pull request directly, outside any merge group, so the job never runs and cannot be bypassed from inside the queue.

The bypass skips more than Melian. GitHub's documentation on merging with a queue says an admin may merge "without waiting for requirements to be met". It skips the queue, the required `check (…)` jobs, thread resolution, and any test of the merged result against current `main`.

Procedure: before a bypass, the maintainer brings the head up to date with `main`, confirms green `check (…)` runs on that head, and comments why.

An option for the maintainer, not adopted: move `melian/review` into a second ruleset that alone carries the bypass, so CI stays mandatory. Whether a queue honours a bypass in a second ruleset is unproven, and it needs a read-only check before anyone relies on it.

## Tests the build must have

Each uses a fake GitHub that answers only the SHA, number or query asked, and a temporary git repository.

1. One pull request whose head has a writer's `success`: posts `success` on the group SHA, naming it.
2. A head with no `melian/review`: posts `failure` naming that pull request.
3. A head with an older `success` and a newer `failure`: posts `failure`. Pins the latest status, as the two statuses on `7abe2a6d` show history exists.
4. `pending`, `error` or `failure` on the head: `failure`.
5. A `success` from a bot, including `github-actions[bot]`, or from a user with `read`: `failure`.
6. A refused `/collaborators/{user}/permission` read: `failure`.
7. A `target_url` naming another pull request or repository: `failure`.
8. A description with no base SHA, an unparseable one, or a base that is not an ancestor of `base_sha`: `failure`.
9. A group of three where the group's own head lacks a status: `failure` naming that one. Where an earlier head lacks one: no status posted.
10. An earlier link absent from the queue but an ancestor of current `main`: passes. One that is neither: no status posted.
11. A last link that differs from `merge_group.head_sha`: `failure`.
12. A first entry whose `baseCommit` differs from `base_sha`: `failure`.
13. A queue entry whose `headRefOid` differs from the merge commit's second parent: `failure`.
14. A one-parent commit, or a first-parent walk that never reaches `base_sha`: `failure`.
15. An API read that fails once and then answers: the second answer decides. One that fails twice: `failure` with the reason, within the command's deadline.
16. The fake records every request: no status is ever written to any SHA but `head_sha`.
17. Workflow lint: the workflow checks out `base_sha` with full history, sets `timeout-minutes`, and grants `statuses: write` and nothing broader.
18. A workflow edit draws the policy notice. This pull request adds it to `packages/core/test/guardrails.test.ts`: under the root `melian.yaml`, an edit, an addition and a rename under `.github/workflows/` and an edit under `.github/actions/` each draw a P1 notice, and without the glob none does.

The mutation check runs on the command before its first round.

## For the attack

The attack on [pull request #166](https://github.com/melian-agent/melian/pull/166) found the policy notice missing from workflow files, and the status unbound to its reviewed base. It found that the position rule raced and could eject the wrong pull request, and that the bypass skipped more than Melian. This revision answers each.

1. **The gate's YAML comes from the group.** A pull request can rewrite it to post `success` unconditionally. The notice now blocks that, but a writer can still forge a `success` over it.
2. **`headCommit` is proven at position 1 only.** The build confirms positions 2 and up on a real queue, read-only, and fails closed otherwise.
