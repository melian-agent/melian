# A cloud builder finishes its own pull request

[Pull request #499](https://github.com/melian-agent/melian/pull/499) was the first pull request finished with no round on the coordinator's host. Its builder ran from a cloud session, and the coordinator set the steps as a trial, so each refusal along the way was recorded.

The session's proxy refused three things. GraphQL blocked `gh workflow run`, `gh pr ready` and `gh pr merge --auto`. A 403 on the collaborator permission read left Melian unable to tell what the viewer may do, so the probing lens ran no probes until the round passed `--trust-head`. A 403 on commit status writes made `melian publish` stop at the status and post nothing. The `melian round` workflow set `melian/review` instead, and the proxy's REST routes marked the pull request ready and queued it.

AGENTS.md's "Working in a cloud session" now records each refusal with what to do, and "Ready and queued" says when a pull request needs no host round. [Issue #526](https://github.com/melian-agent/melian/issues/526) is to read the viewer's own permission, which the proxy answers.
