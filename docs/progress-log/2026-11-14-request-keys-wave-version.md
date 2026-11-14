Codex's third adversarial review of [pull request #436](https://github.com/melian-agent/melian/pull/436) found that a verification wave stood on less than the final verification keys. The coordinator advised the cheaper fix on [issue #394](https://github.com/melian-agent/melian/issues/394#issuecomment-6875751753); the advice is not a ruling.

Problem: a wave is a verifier run that starts as each lens ends, and the final verification copies a standing wave's verdicts instead of asking again. A wave stood while `verifierVersion` matched, a hash of the verifier's instructions, schema and questions. The final request also hashes `verifierText()`: the verifier's tools, its injection policy, the line templates and the hand-over text. Example: a release changes the injection policy and nothing else; the next review copies every wave judged under the old policy. Solution: `waveVersion` in `packages/pipeline/src/verification.ts` keys `verifierVersion` with `verifierText()`, under producer `verification.wave`. Each wave records it, and `startVerification`, `startWave` and `review.ts` compare it. `verifierText()` holds no nonce and no path, so the key is stable across runs.

The fix started with failing tests. At `6a84c118`, two of the three new tests in `packages/pipeline/test/verification-waves.test.ts` failed with `expected [ [ '64f813a9f8e50dfe' ] ] to have a length of 2 but got 1`: "stands no longer once the verifier's text changes under the same version" and "stands no longer for a wave an older Melian recorded under the verifier's version alone". The third, "stands while the verifier's text is unchanged", passed, as it should. After the fix all 30 tests in the file pass. A fourth test ties the pair to the final request: it hashes every input of the final verification key that no candidate's key and no revision field covers, so a field someone adds to that request fails it.

Cost: the waves document keeps version 1. A wave stored by an older Melian holds the bare `verifierVersion`, so after the upgrade it is judged again once, at one verifier call per wave. The full rule, comparing the request key itself, is the follow-up issue.

The changed code guards trust: it decides what a key matches. Its hand mutants are [2026-11-14-issue-394-wave-mutants.json](2026-11-14-issue-394-wave-mutants.json), run at `6a84c118` plus the uncommitted fix, each against its named test alone after that test passed unmutated. All seven were killed:

- Each of the three comparisons in `verification.ts` and the one in `review.ts`, mutated back to the raw version, fails "stands while the verifier's text is unchanged".
- `waveIdentity` without `version` fails "stands no longer once the verifier's text changes under the same version".
- `waveIdentity` without `text`, and as `{}`, fails the tie test.

One mutant is equivalent and was not run: the producer string `"verification.wave"` emptied. Every wave version comes from the one function, so the namespace is not observable.
