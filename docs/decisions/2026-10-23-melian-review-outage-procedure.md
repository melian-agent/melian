# When Melian cannot run, the maintainer overrides one pull request and the ruleset stays active

Amends: [the merge-group decision](2026-10-22-melian-review-on-merge-groups.md), the admin bypass and its procedure

Choice: `melian/review` is the only required context in a second ruleset with no bypass actors. When Melian cannot run, the maintainer posts a `melian/review` `success` on the chosen pull request's head. The merge-group job copies it to the group commit, and the pull request lands through the queue. The ruleset stays `active`. If the merge-group workflow itself cannot run, the maintainer posts the same override on the entry's group commit as well. Nothing disables the ruleset.

Why: the bypass the earlier decision describes does not work, and the obvious replacement, disabling the ruleset, opens the queue to every armed or queued pull request.

## The problem

The earlier decision lets an admin merge directly when no head can get `success`. It prefers a split, with the `check (…)` jobs in one ruleset and `melian/review` in a second that alone carries the bypass, and leaves the split unproven.

Tests on a scratch repository, [melian-agent/ruleset-scratch](https://github.com/melian-agent/ruleset-scratch), on 2026-10-22 ran both layouts.

## Evidence

- **Case c, the split.** A green pull request with no `melian/review` could not enter the queue: the bypass does not apply to enqueue. `gh pr merge --merge --admin` and the REST merge were refused with "Changes must be made through the merge queue", because the main ruleset still requires the queue and has no bypass.
- **Case d, a red `check`.** With `melian/review` green, enqueue and `--admin` both refused, as intended.
- **Case e, one ruleset with the bypass.** `gh pr merge --merge --admin` merged a green pull request with no review around the queue, and merged a red one too.
- **Disabling the ruleset.** While it was disabled, [pull request #8](https://github.com/melian-agent/ruleset-scratch/pull/8) was armed with `gh pr merge --auto` and sat idle. After the ruleset was disabled again, an unrelated status on its head enqueued it with no command. Re-enabling the ruleset before a chosen pull request merged held that group until the queue timed out and ejected it, as [pull request #7](https://github.com/melian-agent/ruleset-scratch/pull/7) showed.
- **Disarming first does not close it.** A pull request already in the queue reads `autoMergeRequest` null, and `gh pr merge --disable-auto` answers `already queued to merge`. A disarming step that inspects auto-merge misses it, and disabling the ruleset removes its last blocker. Two reviews each found a new such path, so the class is the fallback itself: disabling the ruleset opens a window for every pull request.
- **Case a, a hand-posted group status.** A writer posted `melian/review` `success` on a group commit by hand, and the pull request merged ([melian-agent/ruleset-scratch#1](https://github.com/melian-agent/ruleset-scratch/pull/1)). The queue accepts it.

The split enforces the right things, but its bypass is dead weight. Disabling the ruleset puts every armed or queued pull request at risk, and re-enabling it too early wastes the chosen one.

## The procedure

The maintainer overrides one pull request, with the ruleset active. For a pull request with head `<head sha>` and base `<base sha>`, they post:

```
gh api repos/melian-agent/melian/statuses/<head sha> \
  -f state=success -f context=melian/review \
  -f target_url=https://github.com/melian-agent/melian/pull/<n> \
  -f description="Maintainer override: Melian could not run; base <base sha, 40 lowercase hex>"
```

The merge-group job accepts this as it accepts any writer's status: the creator has write permission, `target_url` names the pull request, and the reviewed base in the suffix is an ancestor of the group's base. It copies the status to the group commit. CI, thread resolution and the queue stay enforced, and no other pull request is affected. The status is recorded under the maintainer's name on the head, and the job's copy on the group commit names the pull request.

## When the merge-group workflow cannot run

If the job itself cannot run, no override reaches the group commit. The maintainer posts the same status on the chosen entry's group commit as well as its head. They read the group commit from the queue:

```
gh api graphql -f query='{ repository(owner:"melian-agent",name:"melian"){ pullRequest(number:<n>){ mergeQueueEntry { state headCommit { oid } } } } }'
```

Then they post `melian/review` `success` on `headCommit.oid`, with the same `target_url` and description as the head's override. Each override covers one entry. Every other entry still needs its own, so nothing else changes.

Never disable the `melian-review` ruleset as an outage procedure. Removing the ruleset is the step-10 undo, a decision for the maintainer, not a way to get through an outage.

## Consequences

- The earlier decision's admin-bypass section and its race on `main` no longer apply: every merge goes through the queue.
- A `merge_group` workflow that posts nothing ejects each entry at the queue's check timeout, with reason `checks_timed_out`. A Melian outage with the ruleset active drains the queue instead of blocking it.
- Any writer can post `melian/review` by hand, as the maintainer does in an override. Milestone 3's GitHub App closes that.
