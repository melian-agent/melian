# Step 23a, pass 5: prove the host's surviving mutants

[Pull request #152](https://github.com/melian-agent/melian/pull/152) adds direct tests for all twelve mutation findings from the host's run on `d8039fbc`.

The installed Stryker instrumenter enumerated 49 replacements on the reported lines. Each replacement was applied alone, tested and restored. Forty-eight fail the new tests. The restored tests pass. No production behaviour changes.

CLI tests check both storage closures, reject prefixed round IDs, retain finding IDs and resolution sources, omit blank plan warnings, and ask git for legacy dates alone. They assert the missing-round CLI error and read rounds without provenance. Pipeline tests call `Round.compare` in both directions and read legacy verdicts without provenance, including comparison-only storage.

Finding `644f4829ed4a570e` has one equivalent replacement: `round?.stored` becomes `round.stored`. The earlier verdict guard throws before this access when the round is absent. Its other replacement, `round?.stored.provenance.plan`, fails the missing-provenance test.

Every other reported finding's exact replacement fails. The three static lines in advisory `ef2abe18662bfbef` remain excluded by the maintainer's `ignoreStatic` policy.

The inventory is appended to `tmp/step23a-report.md`. `tmp/step23a-pass5-report.md` records each exact replacement, failed test and validation log. The coordinator must rerun the cold mutation check on the host. The implementation plan and decisions stay unchanged.

The whole gate exits 1: 4,926 tests pass, 53 skip and four fail in the sandbox's process tests. Three report `ps failed: undefined`; the supervisor case reports `toolFailed` instead of `invalidOutput`. Lint, type checking and the audit threshold pass. The host must rerun the whole gate.
