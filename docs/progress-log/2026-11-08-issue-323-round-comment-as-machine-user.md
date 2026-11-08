[Issue #323](https://github.com/melian-agent/melian/issues/323): the `melian round` workflow now posts and edits its comment as `melian-status-bot`, with `MELIAN_STATUS_TOKEN`. `005b9dbb` makes the change.

- The report job never edits a marked comment from another login. It fails before posting when the secret is empty.
- The report job's own token drops to `pull-requests: read`, so nothing in that job posts as `github-actions[bot]`.
- The AGENTS.md check now reads only `melian-status-bot`'s comments, and runs on REST alone. The maintainer ruled on 2026-11-08, in the builder's session, that the nonce need not be checked; [the decision](../decisions/2026-11-08-round-comment-as-the-machine-user.md) says why.
- `docs/design.md`, AGENTS.md's round paragraph and the plan-step template say who posts.
- AGENTS.md's builder-voice bullet, which [pull request #320](https://github.com/melian-agent/melian/pull/320) had placed between the check's prose and its code block, now sits after the check.

Failing first:

- Three cases in `scripts/melian-round-workflow.test.mjs` failed on `main` at `029fcfbd`. The comment was posted with `gh pr comment` and `github.token`. The edit went to comment 55, the marked `github-actions[bot]` one. A same-marker `github-actions[bot]` comment was overwritten with `github.token`.
- The new `scripts/round-comment-check.test.mjs` runs the AGENTS.md check itself over REST answers recorded from round run 42440138303. On `main` it accepted `github-actions[bot]`'s comment and refused `melian-status-bot`'s. All pass now.

The enumerator lists no mutants, since no production module changed. 11 hand mutants of the workflow and the check are all killed, each run against its named test alone with one test collected: [2026-11-08-pr-323-mutants.json](2026-11-08-pr-323-mutants.json). The workflow's first run as `melian-status-bot` comes after merge, and will be recorded on the issue.
