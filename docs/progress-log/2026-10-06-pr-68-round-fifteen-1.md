Closed the GraphQL target-variable test gap from the fifteenth Melian round on [pull request #68](https://github.com/melian-agent/melian/pull/68). Each page of both operations now has assertions for its owner, repository, pull-request number and cursor.

Changing the repository variable from `this.repo` to `this.owner` passed all 70 existing thread and CLI comparison tests. That mutation now fails both new regressions. Separate mutations to the owner and pull-request number also fail both regressions; the other 55 thread tests pass each time. The GitHub testing guideline now requires target-variable assertions because the recorded transport ignores them.

The requested package coverage command cannot find `@vitest/coverage-v8`. Coverage and the uncovered-line audit are skipped as requested; nothing is installed. Production behaviour and design decisions stay unchanged.
