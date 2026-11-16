# [Issue #496](https://github.com/melian-agent/melian/issues/496): a withheld tool version stays consistent across a record

Codex's adversarial review of e34c1d3b found that withholding a check's version broke export. A check record's sightings must name the result's version, and they kept the original, so `ReviewRecords.check` threw `RecordError` for a version such as `1.2.3+build` with one finding. The same version also left the machine through a verification's claims, an account's producers and a dismissal's sighting.

`ReviewRecords` now maps a source's version once, wherever a source leaves: a static check's version passes only in semver's own form of at most 64 characters, or as `unavailable`, and a lens's version passes as written. The 64-character cap is the coordinator's answer on [issue #496](https://github.com/melian-agent/melian/issues/496#issuecomment-6929039707).

Three tests in `packages/pipeline/test/review-records-withheld.test.ts` failed on e34c1d3b. Two threw Codex's `RecordError`, and a 65-character version was exported. All pass after the fix.

Codex's other finding, a sighting's tool message and Enola's receipt, is the tracked limit of [issue #516](https://github.com/melian-agent/melian/issues/516) and [pull request #524](https://github.com/melian-agent/melian/pull/524).

Mutation proof: `2026-11-16-issue-496-version-sources-mutants.json` lists the fix's 28 mutants. All 26 generated mutants were killed, each by its named test run alone after that test passed unmutated. One mutant survived the first run: rebuilding every sighting even when its version is unchanged, which writes an `undefined` version key into the payload. A strict-equality test of a sighting with no version now kills it. The two string literals are ignored by configuration.
