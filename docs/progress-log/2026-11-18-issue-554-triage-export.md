[Issue #554](https://github.com/melian-agent/melian/issues/554) lets a reader of a round's shared records check a skip triage allowed. It does two things.

First, it moves the review's lens selection into `ChangeLenses` in the pipeline, so a reader builds the same selection the review does. Six tests pinned today's selection through the account the review hands adjudication before the move, and pass unchanged after it: a nested `melian.yaml` with a floor of skip, one beside the change, a renamed file's old path, a change that leaves a lens's paths, a moved file held to its head path's band, and a moved file whose both paths set a floor of skip. The coordinator asked for a move, not a rewrite, on 2026-11-18.

Second, a round that asked triage now exports its triage record, with triage's decision or failure and whether its input was cut. The round names the record, and its account counts it, so the account's key commits to what triage decided. A test that reads only the exported records shows `TierAccount.refusal` accepting a round's triage skip with the record and refusing it without. Binding the account to the record was not in the first change: a recorded-round test then refused the round, since the round named a record its account did not count.

The mutation inventory is [2026-11-18-issue-554-triage-export-mutants.json](2026-11-18-issue-554-triage-export-mutants.json), version 2 from `melian mutants list be01a4e1...8c0b318b --claims-in packages/pipeline/src/review.ts --claims-in packages/pipeline/src/change-lenses.ts --json --all`. It lists 93 mutants: 7 ignored by configuration, 76 `killed`, 7 `new-test` and 3 `equivalent`. The seven new-test mutants needed four tests, added in 8c0b318b:
- a triage failure exported with no decision;
- an untrusted review with no decider;
- a lens whose paths hold only some changed files;
- a lens named `rails` beside the `guardrails` check.

The three equivalents are a policy of `undefined`, which `ChangeLenses.read` treats as absent; a failure of `undefined`, which the stored payload leaves out; and an `oldPath` check that never decides, since no file with no old path is in a lens's files. Each of the 83 claimed kills ran by hand against its named test alone, which passed unmutated first, and failed under every mutant; [the runs](2026-11-18-issue-554-triage-export-mutant-runs.json) record each.

The review of record at bc8cfd36 found two gaps, both now fixed:
- The inventory's test evidence named each test by its flat name. The version-2 schema wants the test's `path`, so `node scripts/enumerate-mutants.mjs --sample` refused the file with exit 1. Each of the 83 entries now gives the name split into `path`, and the sampler reads the file.
- No test exported a triage record whose input was cut, and Stryker makes no mutant for the member read that sets `inputCut`. Swapping in `inputCut: false` by hand passed every test. The new test, "records that triage's input was cut, so a reader allows no skip", in 01c26908, passes on the code and fails under that swap.

[2026-11-18-issue-547-review-fixes-mutants-sampleable.json](2026-11-18-issue-547-review-fixes-mutants-sampleable.json) supersedes [the inventory of pull request #552](2026-11-18-issue-547-review-fixes-mutants.json) for sampling. It is that file with its 29 test evidences converted to `path`, since the sampler refuses the merged file for the same fault, and a merged entry's file stays as it landed, by the coordinator's answer of 2026-11-18.
