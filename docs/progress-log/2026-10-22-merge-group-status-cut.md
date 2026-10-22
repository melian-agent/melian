# 2026-10-22: a long status description is cut, never refused

The review of record on [pull request #168](https://github.com/melian-agent/melian/pull/168) found a second way to leave a head's `success` standing. A not-reviewed description of 112 characters plus the reviewed-base suffix passed 140, `setStatus` refused it, and publish stopped before posting `error`. [The cut decision](../decisions/2026-10-22-status-description-cut.md) reverses the refusal: `setStatus` cuts the prose and appends the suffix whole, and the merge-group command no longer cuts its own description.

`packages/cli/test/merge-group-abandoned.test.ts` seeds a writer's `Passed; base …` on the head, publishes a not-reviewed verdict of 112 characters, and runs the merge-group command. On bbe41fb1 publish failed with `commit status description exceeds 140 characters; refusing to cut it`; after 77de64ec the head carries `error` with the cut prose and exact suffix, and the group posts `failure`. `packages/github/test/status.test.ts` holds the bound at 93 and 94 characters of prose.

6b572b1c makes the merge-group check refuse a description with a second `; base `, such as `…; base <head>; base <reviewed>`; both doubled forms posted `success` before it. e881e56f sets `persist-credentials: false` on the copy job's checkout.
