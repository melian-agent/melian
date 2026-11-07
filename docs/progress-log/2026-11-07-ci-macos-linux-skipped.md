For [issue #291](https://github.com/melian-agent/melian/issues/291), `check (macos, 24)` no longer runs the whole gate. It waits for the Linux jobs and downloads the Node 24 job's Vitest JSON report, the authority for which tests Linux skipped. It then runs Vitest on the files holding those tests, plus the two named suites, and fails unless every test Linux skipped passed on macOS, outside the one-entry allowlist, and both suites passed whole. It also fails when the Linux report shows no skipped test. Biome, tsc, the audit and every test that passes on Linux run on Linux alone.

Before the change the job took about 21 minutes on [pull request #290](https://github.com/melian-agent/melian/pull/290), with the Linux jobs at 4 to 7 minutes on Blacksmith. This pull request's own run records the new time. Both `jq` programs were tried by hand against sample reports before the push:
- a complete run passed;
- each of these failed with exit 5: a Linux-skipped test skipped again, one missing, a failed test, an empty named suite, and a Linux report with no skips.

Given up: a test that passes on Linux and fails only on macOS, such as one hit by a `/private/var` path or by path casing, no longer runs on macOS. AGENTS.md's host rerun stays until the maintainer makes the job required.
