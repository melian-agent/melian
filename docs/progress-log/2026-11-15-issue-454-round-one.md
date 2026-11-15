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
