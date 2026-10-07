Closed the query-binding test gap from Melian’s sixteenth round on [pull request #68](https://github.com/melian-agent/melian/pull/68). Both GraphQL operations now assert their repository and pull-request argument bindings on every recorded page.

Swapping the repository’s owner and name bindings passed all 72 existing thread and CLI comparison tests. The same swap fails both new regressions; the other 57 tests pass. Restoring the source passes all 59 thread tests. The GitHub guideline records why both checks are needed. Production behaviour and design decisions stay unchanged.
