# 2026-10-22: merge-group review status, built

[Pull request #168](https://github.com/melian-agent/melian/pull/168) builds step 10's merge-group prerequisite from [the decision](../decisions/2026-10-22-melian-review-on-merge-groups.md). The maintainer still enables the required context and probes the bypass.

`melian status merge-group` validates the event, the own-pull-request ref, both parents and the ALLGREEN MERGE rule. It requires the latest head status to name the pull request, come from a writer, and record an ancestor base. Every API read retries once. The command writes only the group's status and reads no queue.

Publication appends the full reviewed base to the status description and refuses to cut a description over 140 characters. The pipeline supplies the base at both status writes. Publication fixtures omit their unused decision tier and use a short API refusal, preserving their recovery assertions within the new limit.

The workflow runs the base build on Node 24 with full history and the three required permissions. Tests cover the decision's 21 cases, an unknown reviewed-base object, and a trailing-newline ref. The policy test covers edited, added and renamed workflows and an added action. A head that strips the glob still draws the base policy's notice.

The command commit is `51af3c2a`; publication is `cee3380c`; the workflow is `505e2721`. Hand mutation proofs are recorded in the builder's local inventory. The coordinator runs the host mutation check before the first full review.

[Pull request #166](https://github.com/melian-agent/melian/pull/166) merged before the prose corrections, and its base branch was deleted. GitHub refused a draft against that branch, so this draft targets `main`. Its existing decision and progress entry remain immutable. [A narrow amendment](../decisions/2026-10-22-merge-group-status-prose.md) consolidates the residual risk and corrects the history, bypass and added-action wording. The implementation plan marks the prerequisite built and leaves step 10 open.
