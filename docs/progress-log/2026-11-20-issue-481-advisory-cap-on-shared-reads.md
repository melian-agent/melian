# [Issue #481](https://github.com/melian-agent/melian/issues/481): a shared reading caps an unjudged finding only where the host does

For [issue #481](https://github.com/melian-agent/melian/issues/481), on [pull request #575](https://github.com/melian-agent/melian/pull/575).

The review of record found that a reader of shared records capped every lens finding no verifier judged at advisory. The host leaves a finding it holds dismissed out of the verifier's request. So when the reader did not count that dismissal, it read a P1 the host would block on as advisory. Two tests in `recorded-round.test.ts` show it: a dismissal made with no store, and a shared dismissal that no longer holds. Both failed at `90760b7bd`, with the finding read as advisory, and both pass at the fix.

The maintainer agreed on 2026-11-21, in the coordinator's session, to option (d), [recorded here](https://github.com/melian-agent/melian/pull/575#issuecomment-7052774673). It rests on the lens version covering each level's `verify` setting. A new test in `lens.test.ts` confirms it: a level's `verify` changes the version, and the default gives the same version as its explicit value.

The reader now caps an unjudged finding when the round asked its verifier about it, as the verification record's `outcomes` list. It also caps one whose every report came from a level that does not verify. For that, it loads the policy commit's lenses, as they load and as the root `melian.yaml` tunes them, and reads `verify` at each declared level under the source that level reports. A source no lens matches by version and declared level leaves its finding uncapped. The first cut matched only the loaded lens. A lens the root's settings retier or narrow runs under another version, so the reader would have left its quick finding uncapped where the host capped it; a test pins that case.

`Defect.decision` now hands the cap's function the defect's speaker beside each report, since the host keys a verification candidate by the speaker's ID.

`2026-11-20-issue-481-advisory-cap-mutants.json` is the inventory of the fix commit, with `--claims-in` naming `recorded-round.ts` and `adjudication.ts`. `2026-11-20-issue-481-advisory-cap-mutant-runs.json` holds the runs. Each of the 40 mutants ran alone against its named test, which passed unmutated. Thirty-eight failed mutated. Two are equivalent, each with its reason in the inventory: `loadConfig` reads `""` and `"."` as the same root, and every finding the reader adjudicates carries `reportedBy`, so its default never applies.
