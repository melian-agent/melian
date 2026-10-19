# Step 23a pass 9: prove the absent-store refusal

[Pull request #152](https://github.com/melian-agent/melian/pull/152), finding `95595b31e3784611`.

Stryker's exact `CallExpression` mutant replaces the missing-store `throw new CliError(...)` at commands.ts:582 with `;`. It passes the old direct command tests.

A new direct test supplies an absent store path. It requires the missing-round diagnostic and proves SQLite and the round reader remain unopened. The exact mutant now fails because the command resolves with exit zero. The conditional-false mutant fails too. The inverted and always-true conditions fail the existing success cases.

All 21 command tests pass after restoration. Four active mutants at the line were enumerated and killed. None is equivalent. The pass report holds their exact spans, replacements and logs.
