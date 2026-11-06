Fix pass 2 on [pull request #274](https://github.com/melian-agent/melian/pull/274) applies the maintainer's ruling that comments decide, after Codex's adversarial review, Melian's round 2 and the Opus review of record found five more interleaving defects. Commit `07b36017` takes the claim state only from a writer's `status: ready` label and writers' `Claim:` and `Released:` comments, in timeline order. It ignores removals, `status: in progress` labels and the workflow's own label events. A release posted between a claim run's read and its writes is no longer lost, a hand edit is undone by the next comment's run, and a triage user's ready label opens nothing. AGENTS.md, the plan-step template and [the decision](../decisions/2026-11-05-claim-labels-by-workflow.md) drop the hand swap. Commit `62903dd6` fails a run whose comment the timeline does not yet hold, naming the comment. Commit `3835d083` makes the claim-mention test assert who was asked, so it fails with `startsWith` changed to `includes`. Commit `15a25b99` leaves a closed issue's labels alone. Commit `dc599f46` adds tests for a writer's hand edits on a claimed issue and the log line that names a ready label. Each of the script's 35 hand mutants below failed its named test, run alone. A 36th, dropping the `commented` check from the timeline-lag guard, is equivalent: only a label event whose id equals the comment's would tell them apart, and GitHub numbers events and comments in separate sequences.

| Mutant | Test | Result |
| --- | --- | --- |
| pull-request guard removed | ignores a comment on a pull request | killed |
| closed guard never fires | leaves a closed issue's labels alone | killed |
| closed guard always fires | swaps ready for in progress on a writer's first claim | killed |
| permission cache always misses | asks once about a commenter who claims twice | killed |
| admin operand false | accepts a claim from admin permission | killed |
| write operand false | accepts a claim from write permission | killed |
| 404 always rethrown | ignores a claim from someone the permission endpoint does not know | killed |
| 404 check removed | fails without writing when the permission lookup errs | killed |
| lag check never fires | fails, naming the comment, when the timeline does not yet hold the comment that started the run | killed |
| lag check some to every | swaps ready for in progress on a writer's first claim | killed |
| lag id match true | fails, naming the comment, when the timeline does not yet hold the comment that started the run | killed |
| labeled check dropped | is not reopened by a writer's hand removal of the ready label on a claimed issue | killed |
| ready-name check true | is not reopened by a writer's in-progress label on a claimed issue | killed |
| own-token check true | is not moved by the workflow's own label events | killed |
| label actor writer check true | opens nothing on a triage user's ready label, and opens on a writer's later one | killed |
| label never opens | swaps ready for in progress on a writer's first claim | killed |
| label decider text dropped | ignores a release on an issue nobody claimed, without asking who wrote it | killed |
| commented check dropped | reopens claims on a writer's later ready label | killed |
| want-defined check dropped | ignores a writer's release on an issue never marked ready | killed |
| command ternary swapped | swaps ready for in progress on a writer's first claim | killed |
| release command never matches | swaps in progress back to ready on a writer's release | killed |
| startsWith to includes | does not count a comment that only mentions a claim | killed |
| prefix check true | ignores a comment " Claim: builder" | killed |
| commenter writer check true | ignores a claim from read permission | killed |
| toggle ternary swapped | swaps ready for in progress on a writer's first claim | killed |
| comment decider dropped | keeps an earlier writer's claim against a second one | killed |
| no-state return removed | ignores a claim when no event ever labelled the issue ready | killed |
| unwanted ternary swapped | swaps ready for in progress on a writer's first claim | killed |
| add guard always true | writes nothing when the labels already match the claim | killed |
| add guard always false | swaps ready for in progress on a writer's first claim | killed |
| remove guard always true | writes nothing when the labels already match the release | killed |
| remove guard always false | repairs a claim whose remove failed when the run is retried | killed |
| remove before add | repairs a claim whose add failed when the run is retried | killed |
| label names not mapped | writes nothing when the labels already match the claim | killed |
| per_page dropped | swaps ready for in progress on a writer's first claim | killed |
