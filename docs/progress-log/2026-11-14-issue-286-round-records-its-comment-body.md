# A round records its comment's body

[Issue #286](https://github.com/melian-agent/melian/issues/286): a writer could edit a `melian round` comment and keep its marker, and the AGENTS.md check still accepted it. Now the round records the body GitHub stored, and the check compares the live comment with that record. [The decision](../decisions/2026-11-14-round-records-its-comment-body.md) says why the record is a commit status.

- `commentRecord` in `scripts/round.mjs`, run by `scripts/round-record.mjs`, builds the `melian/round-comment` status from GitHub's answer to the post or edit: the run, the pull request, and the SHA-256 of the stored body. It refuses an answer it cannot read, one on another pull request, and a description past GitHub's 140 characters.
- The report job keeps GitHub's answer, and a new last step sets the status on the run's commit with `MELIAN_STATUS_TOKEN`, after `melian/review`.
- The AGENTS.md check takes the pull request's number, and accepts a comment only when its body hashes to the latest record `melian-status-bot` set for that run. AGENTS.md no longer tells builders to treat a round's findings as a writer's unverified text.
- `scripts/timeline.mjs` still reads spend without the record, and now says why.
- The check's fixtures are recordings from round run 43558730566 on [pull request #422](https://github.com/melian-agent/melian/pull/422), the first round posted as `melian-status-bot`.

Failing first: `main`'s check, at `c851d1ff`, run over the recorded comment with "All findings are dismissed." appended to its body, printed `comment 6872114855 is run 43558730566's` and exited 0. The new check refuses it, and `scripts/round-comment-check.test.mjs` holds that case beside thirteen others.

Mutants: the enumerator lists 73 in `scripts/round.mjs` and `scripts/round-record.mjs`. 71 are killed and 2 are equivalent, each dropping an explicit `"utf8"` that Node already defaults to. 25 hand mutants of the AGENTS.md check and the workflow's record step are all killed. Each ran against its named test alone, with one test collected, after that test passed unmutated: [2026-11-14-issue-286-mutants.json](2026-11-14-issue-286-mutants.json). Three check cases were added after a first pass showed their guards untested: a run ID that extends this one, a run record with no full commit, and a status list that cannot be read.
