# When Melian cannot run, disable the `melian/review` ruleset and keep the queue

Amends: [the merge-group decision](2026-10-22-melian-review-on-merge-groups.md), the admin bypass and its procedure

Choice: `melian/review` is the only required context in a second ruleset with no bypass actors. In an outage the maintainer sets that ruleset's `enforcement` to `disabled`, enqueues what must land, and sets it back to `active`. CI, thread resolution and the queue stay enforced throughout.

Why: the bypass the earlier decision describes does not work, and the alternative skips CI.

## The problem

The earlier decision lets an admin merge directly when no head can get `success`. It prefers a split, with the `check (…)` jobs in one ruleset and `melian/review` in a second that alone carries the bypass, and leaves the split unproven.

A test on a scratch repository on 2026-10-22 ran both layouts.

## Evidence

- **Case c, the split.** A green pull request with no `melian/review` could not enter the queue: the admin bypass does not apply to enqueue. `gh pr merge --merge --admin` and the REST merge were both refused with "Changes must be made through the merge queue", because the main ruleset still requires the queue and has no bypass. The bypass lifts nothing useful.
- **Case d, a red `check`.** With `melian/review` green, enqueue and `--admin` both refused, as intended.
- **Case e, one ruleset with the bypass.** `gh pr merge --merge --admin` merged a green pull request with no review around the queue, and merged a red one too.

The split enforces the right things. Its bypass actor is dead weight. One ruleset lets an admin merge a red pull request around the queue.

## The procedure

1. Set the `melian/review` ruleset's `enforcement` to `disabled`: `gh api -X PUT repos/melian-agent/melian/rulesets/<id> -f enforcement=disabled`.
2. Enqueue the pull requests that must land. The queue still requires CI and resolved threads, and tests each merge commit.
3. Set `enforcement` back to `active`, with `-f enforcement=active`, once they land.

While the ruleset is disabled, any pull request can enter the queue without a Melian review. The maintainer enqueues only the ones they have read, and keeps the window short.

The `melian/review` ruleset carries no `bypass_actors`. The ruleset change in the earlier decision drops its bypass actor and puts the `melian/review` context in the second ruleset.

## Consequences

- The earlier decision's admin-bypass section and its race on `main` no longer apply: every merge goes through the queue.
- A `merge_group` workflow that posts nothing ejects each entry at the queue's check timeout, with reason `checks_timed_out`. A Melian outage with the ruleset active drains the queue instead of blocking it.
- Any writer can still post `melian/review` by hand. Milestone 3's GitHub App closes that.
