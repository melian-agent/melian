# `melian/review` on merge-group commits is copied from each pull request's head

Choice: a workflow on `merge_group` runs `melian status merge-group` from the base's build. It finds every pull request in the group, reads `melian/review` on each one's head, and posts `melian/review` on the merge-group commit with the job's `GITHUB_TOKEN`. It posts `success` only when every head's latest status is `success` from a writer. Otherwise it posts `failure` and names the pull request.

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

A new workflow, `.github/workflows/melian-review-group.yml`, runs `on: merge_group: types: [checks_requested]` with `permissions: { contents: read, pull-requests: read, statuses: write }` and `timeout-minutes: 5`. It checks out `merge_group.base_sha`, not the group commit, installs, and runs `melian status merge-group --head <head_sha> --base <base_sha>` from that build. The gate's logic is main's.

The command asks two authorities and requires them to agree:

1. Git. Walk `base_sha..head_sha` by first parent. Every commit must have exactly two parents, its first parent the previous link, ending at `base_sha`. Its second parent is a pull request head. The queue's merge method is `MERGE`; any other shape fails closed.
2. The merge queue. GraphQL `repository.mergeQueue(branch: "main").entries` lists `pullRequest { number headRefOid }` and `headCommit`. Each merge commit on the walk must match one entry's `headCommit`, and that entry's `headRefOid` must equal the merge commit's second parent. The first entries by position, as many as there are links, must be exactly the walk's links, in order; any mismatch fails.

For each head, the command reads `GET /commits/{sha}/statuses`, newest first, and takes the first `melian/review`, never an older one. That status counts only when all of these hold:

- its state is `success`;
- its creator is a `User`, not a bot, so a status the job itself posted never feeds another copy;
- the creator has write, maintain or admin permission now;
- its `target_url` names this repository's pull request with the entry's number, so a head reviewed for another pull request does not lend its status.

The posted status names the pull requests and links to the run. A status belongs to a SHA, and a push removes a pull request from the queue, so the head check is also the stale-head check.

## Trust

Anyone with `statuses: write` can set any context on any commit: a writer's token, an installed app, or the `GITHUB_TOKEN` of a workflow on a branch in this repository. A fork's run gets a read-only token.

So a writer can post a false `melian/review` on a merge-group commit, as they can on a head today. [Writers are trusted](../design.md#writers-are-trusted) by decision, and the job adds no actor who could not already forge the gate.

It adds one path easier to take by accident. A `merge_group` run uses the group commit's workflow file, so a pull request that edits it changes the gate judging its own group. Running the logic from `base_sha` narrows that to the YAML, which Melian's `policy-change-review` notice covers without blocking.

The copy proves the job's identity, not Melian's: a run of this repository's workflow found a writer's `success` on each head. The head status proves no more today.

The job cannot check the signed review marker. `melian publish` signs each marker with HMAC-SHA256 under the changeset's publisher secret, 32 random bytes generated once and kept in Melian's local storage under the git common directory (`packages/pipeline/src/publish.ts`). The secret never leaves the maintainer's machine, so no workflow holds it. An Actions secret would add nothing: the signer is the trusted writer, and a group run, whose workflow the pull request can edit, reads repository secrets.

Residual risk: a writer, or a writer's mistake in the gate's YAML, can pass the queue without a Melian review. It closes in milestone 3, when the GitHub App posts both statuses and the ruleset names the App as `melian/review`'s expected source. The App must then post on merge-group commits itself, since a status from `github-actions[bot]` will no longer count.

## Failure modes

- **A pull request without a status.** The job posts `failure`, naming the pull request and its head, so the queue ejects it at once rather than after 30 minutes.
- **A stale head.** A push removes the pull request from the queue; a head whose latest status is not `success` fails.
- **A group of several.** Each entry's group gets its own `merge_group` event and checks every pull request in it. One unreviewed pull request fails its group and those behind it, and the queue rebuilds them without it.
- **A timeout or an API error.** A failed read posts `failure` with the reason. A job that dies silently leaves the 30-minute timeout, which also ejects.
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

When both model providers are out, no head gets `success`, and the job fails every group. The bypass does not enter the queue: the maintainer merges the pull request directly, outside any merge group, so the job never runs and cannot be bypassed from inside the queue. It skips CI too, so the maintainer bypasses only a head whose `check (…)` runs passed, and comments why.

## Tests the build must have

Each uses a fake GitHub that answers only the SHA, number or query asked, and a temporary git repository.

1. One pull request whose head has a writer's `success`: posts `success` on the group SHA, naming it.
2. A head with no `melian/review`: posts `failure` naming that pull request.
3. A head with an older `success` and a newer `failure`: posts `failure`. Pins the latest status, as the two statuses on `7abe2a6d` show history exists.
4. `pending`, `error` or `failure` on the head: `failure`.
5. A `success` from a bot, including `github-actions[bot]`, from a user with `read`, or whose permission read fails: `failure`.
6. A `target_url` naming another pull request or repository: `failure`.
7. A group of three where the middle head lacks a status: `failure` naming only that one.
8. A queue entry whose `headRefOid` differs from the merge commit's second parent: `failure`.
9. A one-parent commit, or a first-parent walk that never reaches `base_sha`: `failure`.
10. A queue whose leading entries differ from the walk's links, in membership or order: `failure`. Entries behind the group are ignored.
11. A status read that times out: `failure` with the reason, within the command's deadline.
12. The fake records every request: no status is ever written to any SHA but `head_sha`.
13. Workflow lint: the workflow checks out `base_sha`, sets `timeout-minutes`, and grants `statuses: write` and nothing broader.

The mutation check runs on the command before its first round.

## For the attack

1. **The gate's YAML comes from the group.** A pull request can rewrite it to post `success` unconditionally: within writer trust, but the easiest forgery, and the notice does not block.
2. **The review's base is not checked.** A status belongs to a head, not a range. A stacked pull request reviewed against its parent keeps that `success` after retargeting to `main`.
3. **`headCommit` is assumed, not proven.** The design assumes an entry's `headCommit` is its merge commit, and that the queue is readable while checks run. The build confirms both on a real queue, read-only, and fails closed otherwise.
