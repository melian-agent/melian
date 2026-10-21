# 2026-10-22: `melian/review` on merge-group commits, designed

Step 10, required status on `main`, needs `melian/review` on the commit the merge queue tests, or every queued pull request times out after 30 minutes. [The merge-group decision](../decisions/2026-10-22-melian-review-on-merge-groups.md) chooses a `merge_group` workflow that runs `melian status merge-group` from the base's build and copies each head's status onto the group commit. It rules out a pull-request-only requirement, which GitHub does not offer, and a pinned required workflow, which needs GitHub Team.

The design reads the ruleset, the rehearsal's statuses on [pull request #164](https://github.com/melian-agent/melian/pull/164) and the `MergeQueueEntry` schema, all read-only. Nothing is built yet; the decision lists thirteen tests the build must have and the ruleset change the maintainer will make.
