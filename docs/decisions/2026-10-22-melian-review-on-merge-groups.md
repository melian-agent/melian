# `melian/review` on merge-group commits is copied from the group's own pull request

Choice: a workflow on `merge_group` runs `melian status merge-group` from the group's base build. It validates only the group's own pull request: it reads `melian/review` on that pull request's head and posts `melian/review` on the merge-group commit with the job's `GITHUB_TOKEN`. It posts `success` only when the head's latest status is `success` from a writer, for a reviewed base the group's base contains. Otherwise it posts `failure` and names the pull request.

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

A new workflow, `.github/workflows/melian-review-group.yml`, runs `on: merge_group: types: [checks_requested]` with `permissions: { contents: read, pull-requests: read, statuses: write }` and `timeout-minutes: 5`. It checks out `merge_group.base_sha`, not the group commit, with `fetch-depth: 0`, because the ancestry check reads history a depth-one checkout lacks. It installs and runs `melian status merge-group --head <head_sha> --base <base_sha>` from that build.

`base_sha` is the group's parent commit, which may be an earlier group commit that has not landed. The gate's logic is therefore main's plus the earlier entries'. Each of those lands only if its own group passed.

### Only its own pull request

The job validates only its own pull request. It runs only when `github.event_name` is `merge_group`. It requires `merge_group.base_ref` to be `refs/heads/main`. It requires `head_ref` to match `^(refs/heads/)?gh-readonly-queue/main/pr-([1-9][0-9]*)-([0-9a-f]{40})$`, with the captured SHA equal to `base_sha` and to the first parent of `head_sha`. `head_sha` must have exactly two parents, and the second must equal pull request N's `headRefOid`. Any other shape posts `failure`.

The rule depends on ALLGREEN. GitHub documents that under ALLGREEN "the merge commit created by merge queue for each PR in the group must pass all required checks to merge", and that under HEADGREEN only the head's must. Before it validates, the job reads `GET /repos/{owner}/{repo}/rules/branches/main`. It requires exactly one `merge_queue` rule, with `grouping_strategy: ALLGREEN` and `merge_method: MERGE`. It posts `failure` otherwise, including when the rule cannot be read after one retry. Step 10 tests that a HEADGREEN or SQUASH rule fails.

### Why the job no longer walks earlier links

An earlier revision walked the group's earlier merge links and matched each against the merge queue or `main`. Three reviews each found a new race in it, all from one cause: the job compared the queue and `main` read at different moments.

- An earlier entry can land and leave the queue while a later group's job runs, so an exact match on the leading entries ejected an innocent pull request on every rerun.
- A landed link then passed as trusted base, but had no pull request number for status validation.
- A link that landed after the checkout's fetch and before the queue read passed neither test, and a first entry's `baseCommit` read after an earlier entry landed failed the group's own pull request.

Under ALLGREEN each entry is validated by its own group, so earlier links need no check here. The job reads no queue and compares nothing read at two moments, so none of these races can arise.

### The head's status

For the head, the command reads `GET /commits/{sha}/statuses`, newest first, and takes the first `melian/review`, never an older one. That status counts only when all of these hold:

- its state is `success`;
- its creator is a `User`, not a bot, so a status the job itself posted never feeds another copy;
- the creator has write, maintain or admin permission now; a refused `/collaborators/{user}/permission` read fails closed;
- its `target_url` names this repository's pull request N, so a head reviewed for another pull request does not lend its status;
- its description ends with exactly `; base <40 lowercase hex>`, matched as the whole suffix, and `git merge-base --is-ancestor <reviewed base> <base_sha>` succeeds with the history fetched.

The last rule binds the status to the range it reviewed. Problem: a status names a head, not a range. Example: a stacked child reviewed against its parent keeps `success` when it is retargeted onto `main`, and the new range can hold rebased parent commits nobody reviewed. Solution: `melian publish` writes the reviewed base's full SHA into the status description, and the job requires that base to be an ancestor of the group's base. This design does not introduce the gap, since the same status already lets the head into the queue; the same rule could later gate the head.

The format is exact because git is loose: `git merge-base --is-ancestor` accepts an abbreviated SHA and a name such as `HEAD~1`. An abbreviated SHA, a ref name, two SHAs or truncated text fails closed. GitHub cuts a description at 140 characters, and `setStatus` would cut a longer one with "…", which could leave a prefix git still accepts. `melian publish` refuses to write a description it would have to cut, rather than truncating it. A success description with the suffix runs to 73 characters.

The posted status names the pull request and links to the run. A status belongs to a SHA, and a push removes a pull request from the queue, so the head check is also the stale-head check.

## Trust

Anyone with `statuses: write` can set any context on any commit: a writer's token, an installed app, or the `GITHUB_TOKEN` of a workflow on a branch in this repository. A fork's run gets a read-only token.

So a writer can post a false `melian/review` on a merge-group commit, as they can on a head today. [Writers are trusted](../design.md#writers-are-trusted) by decision, and the job adds no actor who could not already forge the gate.

It adds one path easier to take by accident. A `merge_group` run uses the group commit's workflow file, so a pull request that edits it changes the gate judging its own group. Running the logic from `base_sha` narrows that to the YAML. The root `melian.yaml` adds `.github/**` to `policy-change-review.files`, so an edit, addition or rename of any workflow or action draws a notice at the analyser severity, P1. It resolves to `block` and fails the head's status, as [step 28's rule](2026-10-17-acknowledge-status-exact-rule.md) sets out. The base copy of `melian.yaml` decides, so the pull request cannot strip the glob. Before the glob, nothing under `.github/` drew a notice.

The residual risk stays within writer trust. A `pull_request` workflow on a branch in this repository can request `statuses: write`, because the repository's `read` default does not cap an explicit `permissions` key. It can then post a newer `success` on its own head, from `github-actions[bot]`, over the notice's `failure`. The copy job's bot rule rejects that status, but the same pull request can also rewrite the group's YAML, so a deliberate writer gets through. An accidental one does not.

Two residuals remain. Once a workflow symlink has landed, an edit to its target outside `.github/` draws no notice, and whether GitHub reads a workflow through a symlink at all is unproven. Anyone with `statuses: write` can post `success` on a group commit.

For the maintainer at step 10: `integration_id: 15368`, GitHub Actions, on the required context would block that second residual. But a ruleset's required check applies to the pull request's head too, where `melian publish` posts with a user token. It would therefore block every pull request from entering the queue. It is an open question for step 10, not adopted.

The copy proves the job's identity, not Melian's: a run of this repository's workflow found a writer's `success` on the head. The head status proves no more today.

The job cannot check the signed review marker. `melian publish` signs each marker with HMAC-SHA256 under the changeset's publisher secret, 32 random bytes generated once and kept in Melian's local storage under the git common directory (`packages/pipeline/src/publish.ts`). The secret never leaves the maintainer's machine, so no workflow holds it. An Actions secret would add nothing: the signer is the trusted writer, and a group run, whose workflow the pull request can edit, reads repository secrets.

Residual risk: a writer can pass the queue without a Melian review. It closes in milestone 3, when the GitHub App posts both statuses and the ruleset names the App as `melian/review`'s expected source. The App must then post on merge-group commits itself, since a status from `github-actions[bot]` will no longer count.

## Failure modes

- **A pull request without a status.** The job posts `failure`, naming the pull request and its head, so the queue ejects it at once rather than after 30 minutes.
- **A stale head.** A push removes the pull request from the queue; a head whose latest status is not `success` fails.
- **A retargeted head.** A status whose reviewed base is not an ancestor of `base_sha`, or that does not end with the exact base suffix, fails.
- **A group of several.** Each entry's group gets its own `merge_group` event and its own job, which judges only that entry. A `failure` ejects only that pull request; GitHub rebuilds the groups behind it.
- **A queue setting changes.** A ruleset that is not ALLGREEN with `MERGE`, or that cannot be read, fails every group until the decision is revisited.
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

A bypass merges outside the queue, so `main` can advance between the maintainer's check and the merge, and the merged tree is then untested. That is the race the queue exists to prevent. The procedure narrows the window and cannot close it. The maintainer brings the head up to date with `main` and confirms green `check (…)` runs on that head. They comment why. Immediately before merging, they confirm that `main` still equals the base the green checks ran on, and only then merge.

The only way to keep CI mandatory is a split: the `check (…)` jobs in a ruleset with no bypass, and `melian/review` in a second ruleset that alone carries the bypass. This is the preferred option, pending a live probe on the repository that the maintainer runs at step 10; it is not adopted. Whether a queue honours a bypass in a second ruleset is unproven until then, and no one relies on it before.

## Tests the build must have

Each uses a fake GitHub that answers only the SHA, number or path asked, and a temporary git repository.

1. One pull request whose head has a writer's `success` with a valid base suffix: posts `success` on the group SHA, naming it. The test asserts the whole result: the posted state, description and target SHA.
2. An event other than `merge_group`: `failure`.
3. A `base_ref` other than `refs/heads/main`: `failure`.
4. A `head_ref` that matches the pattern with `refs/heads/` and one without: both accepted. A `head_ref` for another base, with a zero or leading-zero number, an abbreviated or uppercase SHA, or trailing text: `failure`.
5. A captured SHA that differs from `base_sha`, or from the first parent of `head_sha`: `failure`.
6. A `head_sha` with one parent or three: `failure`.
7. A second parent that differs from pull request N's `headRefOid`: `failure`.
8. A ruleset with one `merge_queue` rule, ALLGREEN and `MERGE`: passes. HEADGREEN, SQUASH, zero rules or two rules: `failure`. A rules read that fails once and then answers: the second answer decides. One that fails twice: `failure` with the reason.
9. A head with no `melian/review`: `failure` naming the pull request.
10. A head with an older `success` and a newer `failure`: `failure`. Pins the latest status, as the two statuses on `7abe2a6d` show history exists.
11. `pending`, `error` or `failure` on the head: `failure`.
12. A `success` from a bot, including `github-actions[bot]`, or from a user with `read`: `failure`.
13. A refused `/collaborators/{user}/permission` read: `failure`.
14. A `target_url` naming another pull request or repository: `failure`.
15. A description with no base, an abbreviated SHA, an uppercase SHA, a ref name, two SHAs, text after the SHA, or a description cut with "…": `failure`.
16. A reviewed base that is not an ancestor of `base_sha`: `failure`. One that is, through an earlier group commit not yet on `main`: passes.
17. `melian publish` refuses a description longer than 140 characters rather than cutting it.
18. Any other API read that fails once and then answers: the second answer decides. One that fails twice: `failure` with the reason, within the command's deadline.
19. The fake records every request: no status is ever written to any SHA but `head_sha`, and the job never reads the merge queue.
20. Workflow lint: the workflow checks out `base_sha` with full history, sets `timeout-minutes`, and grants `statuses: write` and nothing broader.
21. A workflow edit draws the policy notice. This pull request adds it to `packages/core/test/guardrails.test.ts`. Under the root `melian.yaml`, an edit, an addition and a rename under `.github/workflows/` and an edit under `.github/actions/` each draw a P1 notice, and without the glob none does. A head that strips the glob and edits a workflow in the same change still draws it, because the base's policy decides.

The mutation check runs on the command before its first round.

## For the attack

The attacks on [pull request #166](https://github.com/melian-agent/melian/pull/166) found the policy notice missing from workflow files, and the status unbound to its reviewed base. Three reviews found races in the position rule, and one found that the bypass skipped more than Melian. This revision answers each: the job now validates only its own pull request, under a confirmed ALLGREEN queue.

1. **The gate's YAML comes from the group.** A pull request can rewrite it to post `success` unconditionally. The notice now blocks that, but a writer can still forge a `success` over it.
2. **ALLGREEN is GitHub's documented behaviour, not a probe.** The job fails closed when the ruleset says otherwise, and step 10 tests that it does.
