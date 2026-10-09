# [Pull request #98](https://github.com/melian-agent/melian/pull/98): round-six environment fixes

Round six found a missing HOME in a Vitest test child and a Linux sandbox test that detected its backend after changing PATH.

- 9b02f128 gives the related-test Vitest child a scratch HOME. It fixes two eval argument-validation children with the same omission.
  It adds the HOME learning to AGENTS.md and a real-seatbelt regression for libuv's home lookup.
- 977887b8 detects the sandbox once before the PATH stub. Both PATH and backend assertions use that instance.

The production spawn trace found no missing HOME on the sandboxed Stryker path.
MutationRun supplies its scratch home; the supervisor, Stryker workers and Vitest workers preserve it.

Removing the production HOME override failed the existing environment test: it received the host home instead of the scratch home.
The mutation changed no signal code. The source was restored.

The new real-seatbelt test skipped because this Codex session cannot start a nested sandbox.
Removing HOME from the fixed Vitest child under real seatbelt remains unproved here.
The PATH mutation's proof is [Linux CI run 37774186910](https://github.com/melian-agent/melian/actions/runs/37774186910).
Its original form failed on Node 22, 24 and 26.

The full gate passed on its first run: 118 test files passed and 2 skipped; 3,247 tests passed and 61 skipped.
The gate covered the clean CLI review that round five could not explain.
Real sandbox and supervisor tests remain skipped where sandbox-exec or ps is denied.

The spawn trace, mutation inventory, skipped-test list and verbatim gate summary are in tmp/fix98-env-report.md.
The gate log is tmp/fix98-env-check.log.
