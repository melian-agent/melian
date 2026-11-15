# [Issue #454](https://github.com/melian-agent/melian/issues/454): Melian's first round on the LANG key

Melian's own-build round at `873f640c`, on [pull request #464](https://github.com/melian-agent/melian/pull/464), read `findings`, not blocking, in 10 minutes for $4.37. It raised one acknowledge finding and two advisories.

## No test proved the reuse a LANG change prevents

The tests lens found that nothing showed `runChecks` declining to attach to an earlier mutation run once `LANG` changes. The key tests proved the hash; rule three of [the identity guideline](../guidelines/identity.md#tests-a-key-needs) also asks for the reuse itself.

"attaches to a mutation run only under the LANG it ran with, and to any other run under any LANG", in `packages/pipeline/test/checks.test.ts`, runs a plain tier under `en_AU.UTF-8` and then `C.UTF-8`, and expects one identity. It then runs the same tier with mutation on: twice under `en_AU.UTF-8`, expecting one identity, then under `C.UTF-8` and with `LANG` unset, expecting three policies and three tasks.

The behaviour was already right, so the test passed at `873f640c` (1 passed). No failing-first run is possible for a finding of untested behaviour. Two mutants stand in for it, each run against this test alone:

- `checkRequest({ ...facts, lang: null })` in `checks.ts`, which drops `LANG` from the key: it failed with `expected 'be88d2aa44c5c9c2' not to be 'be88d2aa44c5c9c2'`, at line 422.
- Keying `{ lang: input.lang }` with mutation off in `check-request.ts`: it failed at line 411, where the plain tier's identity under `C.UTF-8` differed from the one under `en_AU.UTF-8`.

Both source files were restored after each run, and `git status` showed only the test changed.

## Advisories

- The internal `lang` field of `CheckRequestInput` carried TSDoc. It is now a line comment.
- The check request's row in the identity guideline held a sentence of over 45 words. It is now three sentences; the pull request's copy of the row matches.

## Round two

Round two, at `6529ba81`, read `findings`, not blocking, in 10 minutes for $5.44, with two advisories and nothing above. The row's list of what the request holds was one sentence of 77 words, and is now four. This entry's title now links the issue.

## The review of record

The Opus review of record at `51757f1d` would not block, and raised one P3: `docs/design.md` still said another host imports every record whose key matches, with no word of the ruling that a mutation run never crosses hosts. The design now names that exception beside the sentence, and links the amendment. No test can reproduce a documentation finding.

## The Actions round

The `melian round` workflow at `cc6b9d0e` read `findings`, not blocking, in 5.5 minutes for $4.88, with one acknowledge finding from the design lens. The amendment said the shared record never carries a mutation run, but amended only the request-keys decision, so the shared-record decision's rules 2 and 8, which share and import every matching check result, still stood with nothing to say this exception wins. The amendment now amends those two rules as well, and says how the manifest stays complete: the importing host runs the mutation check itself. No test can reproduce a finding on the decision graph; the decisions suite, 532 tests, passed after the change.

## Round three

Round three, at `cc6b9d0e`, read `findings`, blocking, in 10.5 minutes. The design lens raised the Actions round's finding again, as a P1 block; the commit above fixes it. Its one advisory was the design's new sentence on the mutation exception, of over 45 words, which is now three sentences.

## Round four, and the corrected ruling

Round four, at `22c8f2ff`, read `findings`, blocking, in 10 minutes for $4.30. The design lens found that leaving mutation results out of the shared record broke three more of its rules. Rule 4 makes a round that names a missing record read not reviewed, and rules 6 and 7 relay a fork's mutation result from the job that ran its code to the trusted job. Two rounds running had found a new instance of one class, so the builder stopped and raised it with the coordinator. The coordinator found the collision came from its own wording of the question it put to the maintainer, "the shared record never carries one". The maintainer answered "Agree" on 2026-11-15, in the coordinator's session, to the correction: the record carries a mutation result, for the round that read it and as a fork's relayed result, and no other host's run reuses it. The amendment now amends rule 8's import alone.

## Round five

Round five, at `a3496387`, read `findings`, not blocking, in 8.5 minutes for $3.60. It raised one P2 acknowledge from the identity lens: `PATH`, `HOME` and `TMPDIR` can change on one host too, from shell to shell, while every keyed fact stays the same, so a review there can reuse a mutation run made under different values. The decision stated only the cross-host limit. On the coordinator's instruction, the decision's limit section and the identity row now state the same-host limit, and what [issue #458](https://github.com/melian-agent/melian/issues/458) would leave for `PATH`. The finding stays an acknowledge, for the maintainer's read.
The maintainer accepted the same-host limit on 2026-11-15, in the coordinator's session, and the decision now says so.

## The Actions round and the review of record at `a0e3f909`

The `melian round` workflow's round, [run 43697244024](https://github.com/melian-agent/melian/actions/runs/43697244024), read `passed` at `a0e3f909`, with no findings above advisory, in 369 seconds for $5.52. The Opus 5.5 review of record at `a0e3f909` would not block. It raised one P3: `checkRequest`'s TSDoc still said only the paths that name the host are left out, though the key also leaves out `LANG` with mutation off, and `PATH`, `HOME` and `TMPDIR`. The next commit corrects the comment. No test can fail on a comment, so the fix has none; the review of record's reading of the comment against the identity row stands in for one. On the coordinator's instruction no Actions round follows the fix: the host finish runs a round from the pull request's own build on the final head, and a one-line comment gives a second round nothing new to read.
