# When Melian cannot run, the maintainer overrides one pull request and the ruleset stays active

Amends: [the merge-group decision](2026-10-22-melian-review-on-merge-groups.md), the admin bypass and its procedure

Choice: `melian/review` is the only required context in a second ruleset with no bypass actors. When Melian cannot run, the maintainer posts a `melian/review` `success` on the chosen pull request's head. The merge-group job copies it to the group commit, and the pull request lands through the queue. The ruleset stays `active`. Disabling it is a fallback for one case only: the merge-group workflow itself cannot run.

Why: the bypass the earlier decision describes does not work, and the obvious replacement, disabling the ruleset, opens the queue to every armed pull request.

## The problem

The earlier decision lets an admin merge directly when no head can get `success`. It prefers a split, with the `check (…)` jobs in one ruleset and `melian/review` in a second that alone carries the bypass, and leaves the split unproven.

Tests on a scratch repository, [melian-agent/ruleset-scratch](https://github.com/melian-agent/ruleset-scratch), on 2026-10-22 ran both layouts.

## Evidence

- **Case c, the split.** A green pull request with no `melian/review` could not enter the queue: the bypass does not apply to enqueue. `gh pr merge --merge --admin` and the REST merge were refused with "Changes must be made through the merge queue", because the main ruleset still requires the queue and has no bypass.
- **Case d, a red `check`.** With `melian/review` green, enqueue and `--admin` both refused, as intended.
- **Case e, one ruleset with the bypass.** `gh pr merge --merge --admin` merged a green pull request with no review around the queue, and merged a red one too.
- **Disabling the ruleset.** While it was disabled, [pull request #8](https://github.com/melian-agent/ruleset-scratch/pull/8) was armed with `gh pr merge --auto` and sat idle. After the ruleset was disabled again, an unrelated status on its head enqueued it with no command. Re-enabling the ruleset before a chosen pull request merged held that group until the queue timed out and ejected it, as [pull request #7](https://github.com/melian-agent/ruleset-scratch/pull/7) showed.

The split enforces the right things, but its bypass is dead weight. Disabling the ruleset puts every armed pull request at risk, and re-enabling it too early wastes the chosen one.

## The procedure

The maintainer overrides one pull request, with the ruleset active. For a pull request with head `<head sha>` and base `<base sha>`, they post:

```
gh api repos/melian-agent/melian/statuses/<head sha> \
  -f state=success -f context=melian/review \
  -f target_url=https://github.com/melian-agent/melian/pull/<n> \
  -f description="Maintainer override: Melian could not run; base <base sha, 40 lowercase hex>"
```

The merge-group job accepts this as it accepts any writer's status: the creator has write permission, `target_url` names the pull request, and the reviewed base in the suffix is an ancestor of the group's base. It copies the status to the group commit. CI, thread resolution and the queue stay enforced, and no other pull request is affected. The status is recorded under the maintainer's name on the head, and the job's copy on the group commit names the pull request.

## The fallback: the merge-group workflow cannot run

If the job itself cannot run, no override reaches the group commit. Then, and only then:

1. List open pull requests with auto-merge armed: `gh pr list --json number,autoMergeRequest`. Run `gh pr merge <n> --disable-auto` on each one that is not chosen.
2. Set the ruleset's `enforcement` to `disabled`: `gh api -X PUT repos/melian-agent/melian/rulesets/<id> -f enforcement=disabled`.
3. Enqueue the chosen pull requests.
4. Keep the ruleset disabled until they merge or are ejected, for at most an hour.
5. Set `enforcement` back with `-f enforcement=active`, and confirm it reads `active`, whatever happened.
6. Re-arm the pull requests disarmed in step 1.

## Consequences

- The earlier decision's admin-bypass section and its race on `main` no longer apply: every merge goes through the queue.
- A `merge_group` workflow that posts nothing ejects each entry at the queue's check timeout, with reason `checks_timed_out`. A Melian outage with the ruleset active drains the queue instead of blocking it.
- Any writer can post `melian/review` by hand, as the maintainer does in an override. Milestone 3's GitHub App closes that.
