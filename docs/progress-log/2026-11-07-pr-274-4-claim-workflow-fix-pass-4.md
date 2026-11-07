Fix pass 4 on [pull request #274](https://github.com/melian-agent/melian/pull/274) applies the maintainer's ruling on Melian finding `70dc5f930ac12a42`: the claim workflow counts a collaborator as a writer when the permission endpoint's `permission` is `admin` or `write`, or its `role_name` is `admin`, `maintain` or `write`. A test of `{ permission: "read", role_name: "maintain" }` failed before the change, and so did the same response with `role_name` `admin` or `write`. A custom role whose `permission` is `write` still counts, and one whose `permission` is `read` does not. [The decision](../decisions/2026-11-05-claim-labels-by-workflow.md) states the rule. Every claim of the pull request was rerun at this head: each of the script's 51 hand mutants below failed its named test, run alone. Two of fix pass 3's 45 gave way to the eight on the new check.

| Mutant | Test | Result |
| --- | --- | --- |
| pull-request guard removed | ignores a comment on a pull request | killed |
| closed guard never fires | leaves a closed issue's labels alone | killed |
| closed guard always fires | swaps ready for in progress on a writer's first claim | killed |
| permission cache always misses | asks once about a commenter who claims twice | killed |
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
| permission list drops admin | accepts a claim from admin permission | killed |
| permission list drops write | decides a writer from the endpoint's own response {"permission":"write","role_name":"release-manager"} | killed |
| permission check false | decides a writer from the endpoint's own response {"permission":"write","role_name":"release-manager"} | killed |
| or becomes and | accepts a claim from admin permission | killed |
| role check true | ignores a claim from read permission | killed |
| role list drops admin | decides a writer from the endpoint's own response {"permission":"read","role_name":"admin"} | killed |
| role list drops maintain | decides a writer from the endpoint's own response {"permission":"read","role_name":"maintain"} | killed |
| role list drops write | decides a writer from the endpoint's own response {"permission":"read","role_name":"write"} | killed |
