# Mutation check: round-ten fixes

[Pull request #98](https://github.com/melian-agent/melian/pull/98) fixes five round-ten items:

- a026231f fixes wrong-result 2f3d2605fabc30f6 and its criterion-selection-bias twin d518369b809ac3cb. Only proven literal Vitest config options narrow selection. Shorthand, indirect, merged and function configs select the whole suite. fe131c83 adds the array-spread fallback found in self-review. Removing each spread or computed-key guard fails a regression.
- 20559436 fixes untested-behaviour eed6f432aa9bb67b. Two matching push events prove that the newest actor wins on one page and across two pages. The CLI refuses the newest read-only actor. Changing find to findLast fails all three tests.
- f9c62a9c fixes secret-exposure 186870e14423be66. Seatbelt reads five device literals and grants no terminal family or fd alias. The pty fixture passes its slave path to the host probe. Restoring the /dev subtree or allowing a ttys regex fails the policy test. An extra closing parenthesis fails the portable profile-balance test.
- 462d7cfe fixes quoted-rule-violation f76ff088050f80ba. The historical sandbox decision matches origin/main exactly. A new successor records retained confinement and the existing cleanup order: unlock, confined removal, prune, scratch last. No main-owned decision or progress entry differs.
- 0dea03be fixes the mutation dry-run failure. Repository-scale decisions and triage fingerprints read the commit under test. Fixtures without main or remote refs prove both checks. Restoring origin/main fails those fixtures; omitting an active decision row fails the index assertions. Historical fingerprint comparisons remain covered in fixture repositories.

The mutation inventory and logs are in tmp/fix98-r10-report.md. All signal-sending files stayed unchanged.

The whole gate passed in the task sandbox: 126 test files passed, with 4,002 tests passed and 62 skipped. Host sandbox and process-table proofs remain the coordinator’s checks. The gate log is tmp/fix98-r10-check.log.
