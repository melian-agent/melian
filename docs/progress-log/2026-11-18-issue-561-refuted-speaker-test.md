# Issue 561: a refuted speaker's sighting scores nothing

[Pull request #550](https://github.com/melian-agent/melian/pull/550)'s round 44241903552 found no test of the speaker's verification reaching the claim `Finding.claimAs` builds when a merge copied no claim. Dropping it let a refuted speaker at an expectation's lines score found.

A test in `packages/evals/test/goldens.test.ts` now gives a `lens.tests` speaker at line 11, with no other claims, a confirmed and then a refuted verification. It passes at the head. Each mutant the finding names, `false ? {} : {}` and `true ? {} : { verification }` at the spread in `packages/core/src/findings.ts`, fails it.
