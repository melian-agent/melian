# Recorded publishers govern recovery

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 9c.

Recovery reads the publisher from the pending round's ledger, including after a retarget.
It journals a changed publisher before posting and supersedes tasks whose login differs in either direction.
A legacy task with no login is superseded once under a known login.
The fresh task posts one review; the old task ends superseded.

Identity reads cache successful logins and definite installation-token refusals.
Transient failures throw before publication journals anything and remain retryable.
Addressed roots bind to recorded review IDs. Ledger discovery prefers its recorded author.
The decision and GitHub guideline describe those authorities and the legacy Bot fallback.

Pass 9b recorded failing tests on `dbeec2f4` before preserving the candidate.
The seven candidate suites passed 319 tests after the coordinator settled the version-1 expectation.
A new missing-ledger test then exposed a transaction-proxy clone in the candidate.
It failed before the fix and passed after cloning the detached pending snapshot.
The version-8 reopen fixture was written by unchanged main at `ac4e8c07`.

Hand mutation runs use exact replacements from the installed Stryker instrumenter.
The inventory, failing and passing output, equivalents and gate result are in `tmp/orphan-thread-pass9c-report.md`.
The coordinator must run the host gate and mutation round because the task sandbox denies `ps`.
The whole gate passed 4,872 tests and failed four existing process tests.
Three reported denied `ps` calls; the supervisor test returned `toolFailed` instead of `invalidOutput`.
All publication tests passed. Formatting, type checking and the audit threshold passed.
The implementation plan stays unchanged: this pass fixes the existing publication step.
