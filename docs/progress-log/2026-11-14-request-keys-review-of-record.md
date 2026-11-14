An Opus 5.5 review of record of [pull request #436](https://github.com/melian-agent/melian/pull/436) at `d127d7bc...7ea1e50b` raised four findings. Its gate passed: 9,267 tests passed and 63 skipped.

- R1, P2: a run made beside an unrecorded `node_modules` was reused once `node_modules` was deleted. The round at the same head blocked on it too. `b888477b` keys whether the install is identified, failing test first, as [the entry](2026-11-14-request-keys-identified-install.md) records.
- R2, P3: a key renders text under `identityNonce`, 24 zeros, and `quoteUntrusted` replaces the nonce with `[nonce]`. So a body holding 24 zeros keys the same as one holding `[nonce]` in that place, though the decider is shown different text. It went to the coordinator, since no fixed nonce avoids it.
- R3, P3: triage's key changed, so each stored revision asks triage once more, and a different answer reruns a lens. `12e1a0d8` prices that in [the decision](../decisions/2026-11-14-request-keys-as-built.md#what-this-gives-up).
- R4, P3: the wave commit `c5df92e0` had eight generated mutants in `verification.ts` that no enumerator inventory claimed; its proof was hand mutants alone. [The inventory](2026-11-14-issue-394-wave-generated-mutants.json) over `c5df92e0^...c5df92e0` now claims all eight. [The runs](2026-11-14-issue-394-wave-generated-mutant-runs.json) at `12e1a0d8` killed all eight, each against its named test alone after it passed unmutated. One, `waveVersion`'s body emptied, survived the changed-text test first, and is killed by "stands while the verifier's text is unchanged". Nine `host.ts` claims in [the first inventory](2026-11-14-issue-394-mutants.json) named `packages/core/test/request-key.test.ts`, though the host tests already lived in `packages/core/test/host.test.ts` at its head. They now name that file. [Their runs](2026-11-14-issue-394-host-mutant-runs.json) at `12e1a0d8` killed all nine.

The round at `7ea1e50b` also found the triage section of [the pipeline guideline](../guidelines/pipeline.md) stale. `35794521` says triage attaches by its whole request. Its four other install-key findings were answered from the decision's lists, and `12e1a0d8` adds four entries to the list of what a check key leaves out:

- the install changing while a check runs, by the coordinator's answer;
- the working-tree policy window;
- how each tool's version is read;
- other hosts' facts.
