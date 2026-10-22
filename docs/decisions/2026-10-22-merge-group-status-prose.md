# Merge-group status prose after the build

Amends: [the merge-group decision](2026-10-22-melian-review-on-merge-groups.md), Options (c), queue history, residual-risk paragraphs, admin bypass wording, and test 21.

Choice: use the following prose for those passages. The own-pull-request rule remains the specification for [pull request #168](https://github.com/melian-agent/melian/pull/168).

Why: [pull request #166](https://github.com/melian-agent/melian/pull/166) merged before the build reached these corrections. Landed decision and progress entries are immutable.

## Option (c)

**Require the check for pull requests only.** GitHub offers no such option. Its documentation couples pull request and queue checks under branch protection or rulesets. The `required_status_checks` schema takes a context and an optional `integration_id`. It has no event selector.

## Queue history

These replace the three history bullets under “Why the job no longer walks earlier links”.

- An earlier entry can land and leave the queue while a later group's job runs. Exact matching then ejects an innocent pull request on reruns.
- A landed link passed as a trusted base. It had no pull request number for status validation.
- A link could land between checkout and queue read, so neither test recognised it. A first entry's `baseCommit` could also move after an earlier entry landed.

## Residual risk

This paragraph replaces the three paragraphs beginning “The residual risk stays”, “Two residuals remain”, and “Residual risk”.

Residual risk: a writer can pass the queue without a Melian review. A same-repository `pull_request` workflow can request `statuses: write` despite the repository's read default. It can overwrite a policy notice's failure with a bot's success. The copy job rejects that bot, but a deliberate writer can also rewrite the group's YAML. Once a workflow symlink lands, edits to its target outside `.github/` draw no notice. Whether GitHub reads workflow symlinks remains unproven. Any actor with `statuses: write` can forge a group status. Milestone 3 closes this gap through the GitHub App as the required context's expected source. The App must post both head and merge-group statuses; a copied Actions status will no longer count.

In the expected-source discussion, “that second residual” means a forged group status. Pinning GitHub Actions still rejects the maintainer's user-token head status, so it remains unadopted.

## Admin bypass

The maintainer merges directly, outside any merge group, so the job never runs; the bypass works only outside the queue.

## Test 21

The fixture adds `.github/actions/x/action.yml` on the head side alone. The test and progress entry call it an added action. Edited, added and renamed workflows remain the other cases.
