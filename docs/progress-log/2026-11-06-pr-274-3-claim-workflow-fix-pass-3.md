Fix pass 3 on [pull request #274](https://github.com/melian-agent/melian/pull/274) closes the recovery gaps Codex's adversarial review and Melian's round 3 found, and the Opus review of record's three notes. Commit `b08e7b8b` rewrites the non-writer release test, which made the ready labeller a non-writer too and so passed with a mutant that lets any release count. A separate read-only user now releases, and the test asserts that their permission was read and the claim stands. Commit `2bff5edf` clears both status labels when no writer's ready label opens the issue, so a triage user's ready label, both labels together, or an in-progress label whose labeller lost write no longer survive later comments. Commit `b17553c1` asks GitHub for a triggering comment the timeline lacks: a 404 means it was deleted and the run reconciles, and only a comment that still exists is lag. Commit `645f0814` says in [the decision](../decisions/2026-11-05-claim-labels-by-workflow.md) that closing an issue withdraws it from claims, that permission is read at run time, and that a permission lookup that fails closes every later run. Removing `status: ready` does not withdraw an issue under the ruling, because the next run puts the label back. Each of the script's 45 hand mutants below failed its named test, run alone.

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
| no-state branch never taken | clears both status labels when no writer's ready label opens the issue | killed |
| clear guard always true | ignores a claim when no event ever labelled the issue ready | killed |
| clear guard always false | clears both status labels when no writer's ready label opens the issue | killed |
| clear list drops in progress | clears both status labels when no writer's ready label opens the issue | killed |
| clear list drops ready | opens nothing on a triage user's ready label, and opens on a writer's later one | killed |
| deleted-comment 404 check removed | fails without writing when GitHub errs on the comment that started the run | killed |
| deleted-comment 404 always rethrown | reconciles from the timeline as it stands when the comment that started the run was deleted | killed |
| 404 reads as present | reconciles from the timeline as it stands when the comment that started the run was deleted | killed |
| present reads as deleted | fails, naming the comment, when the timeline does not yet hold the comment that started the run | killed |
| lag throw never fires | fails, naming the comment, when the timeline does not yet hold the comment that started the run | killed |
| any release counts | ignores a release from a non-writer | killed |
| unwanted ternary swapped | swaps ready for in progress on a writer's first claim | killed |
| add guard always true | writes nothing when the labels already match the claim | killed |
| add guard always false | swaps ready for in progress on a writer's first claim | killed |
| remove guard always true | writes nothing when the labels already match the release | killed |
| remove guard always false | repairs a claim whose remove failed when the run is retried | killed |
| remove before add | repairs a claim whose add failed when the run is retried | killed |
| label names not mapped | writes nothing when the labels already match the claim | killed |
| per_page dropped | swaps ready for in progress on a writer's first claim | killed |
