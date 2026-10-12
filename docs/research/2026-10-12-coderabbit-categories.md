# CodeRabbit's categories

How [CodeRabbit](https://www.coderabbit.ai) labels its findings, what they are about, what happened to them, and which of Melian's lenses would own each.

Source: CodeRabbit's reviews on 80 pull requests across four private repositories, read with the maintainer's access through the GitHub GraphQL API. The repositories are called A to D here. Examples are paraphrased, nothing is quoted, and no repository is named. [The anatomy of CodeRabbit's output](2026-10-04-review-output-anatomy.md) describes the comment format itself.

## Sample

| Repository | Pull requests | Inline findings | Character |
|---|---|---|---|
| A | 20 | 104 | A web application. Most reviewed files are specification, plan, and task documents. |
| B | 20 | 54 | A TypeScript web application. |
| C | 20 | 16 | A TypeScript chat bot. |
| D | 20 | 25 | A TypeScript monorepo, with a workflow and a drift check. |
| Total | 80 | 199 | |

The sample is the 20 most recently updated pull requests CodeRabbit reviewed in each repository. All were updated between 2026-09-30 and 2026-10-12, so only the current comment format appears. Another 25 findings sit in review bodies and have no thread: nitpicks, comments outside the diff, and one duplicate. That gives 224 labelled findings. Most reviews ran under the quieter of the two review profiles.

## Taxonomy and counts

Every finding opens with one line of three fields: a category, a severity, and an effort.

| Category | Count | Share |
|---|---|---|
| Functional correctness | 120 | 54% |
| Data integrity and integration | 43 | 19% |
| Maintainability and code quality | 32 | 14% |
| Stability and availability | 15 | 7% |
| Security and privacy | 13 | 6% |
| Performance and scalability | 1 | under 1% |

Severity is minor on 158 findings, major on 49, and trivial on 17. No finding is critical. Effort is a quick win on 194, a heavy lift on 19, and low value on 11.

| Category | Major | Minor | Trivial | Total |
|---|---|---|---|---|
| Functional correctness | 17 | 100 | 3 | 120 |
| Data integrity and integration | 16 | 27 | 0 | 43 |
| Maintainability and code quality | 4 | 15 | 13 | 32 |
| Stability and availability | 3 | 12 | 0 | 15 |
| Security and privacy | 9 | 4 | 0 | 13 |
| Performance and scalability | 0 | 0 | 1 | 1 |
| Total | 49 | 158 | 17 | 224 |

Trivial lives almost wholly under maintainability, mostly as review-body nitpicks. Security is the one category weighted toward major, at 9 of 13.

Each inline comment also carries a hidden marker with an older, coarser type. It reads potential issue on 192 of the 199, refactor suggestion on 4, and nitpick on 3. The six visible categories replaced it.

Some findings name where they came from: a stored learning on 9, a guidelines file on 5, and a linter or scanner on 4. So a repository's written standards do reach the reviewer.

## Tools and the model

A model writes almost every finding.

- Linter output appears in about one inline finding in ten, 19 blocks in all. Most come from prose and Markdown linters run on documentation. No general security scanner appears in the sample.
- 60 of the 199 inline findings, 30%, show that the model ran shell commands over the checkout before it posted. It searches and prints lines to check a claim about another file. This is a verification pass by the model, not a linter.
- 52 findings carry a suggested fix as a diff.
- Every inline finding, 199 of 199, carries a prompt for a coding agent. The prompt opens by telling the agent to treat the text as untrusted.

## What the findings are about

One reader sorted 172 of the 199 inline findings into the nearest Melian lens, or none. The sample was stratified across the repositories. A finding about a specification document counted as none, since no lens compares one document with another.

| Lens | Count | Share |
|---|---|---|
| `correctness` | 69 | 40% |
| `contracts` | 1 | 1% |
| `trust-boundary` | 12 | 7% |
| `removed-behaviour` | 2 | 1% |
| `tests` | 2 | 1% |
| `conventions` | 10 | 6% |
| `design` | 3 | 2% |
| `durability` | 10 | 6% |
| None | 63 | 37% |

Repository A supplies 38 of the 63 with no lens. In repository B, 29 of 54 findings are correctness and 7 are trust boundary.

Examples, paraphrased:

- `correctness`: a year-to-date total includes last December in January, because a month comparison is inclusive. A read of an empty configuration file returns nothing, and the next lookup raises.
- `contracts`: a later change in a planned chain removes a method before its last caller is migrated. This was the only one.
- `trust-boundary`: any signed-in user can change a setting on another user's record, because the route checks only that no record exists. Free text reaches a chat message unescaped, so it can ping a whole channel.
- `removed-behaviour`: a rewrite of an input step drops its rejection of negative numbers.
- `tests`: acceptance coverage is missing for writes that must stop. Both examples sat in a specification, not a test file.
- `conventions`: a task list omits the repository's mandatory gate. Database calls belong in a data-access method, by the repository's guidelines.
- `design`: a task increments a counter that the specification says stays unchanged.
- `durability`: a rollback migration renames records written after the migration, and loses data. A publish after a committed transaction has no retry, so one failure strands the rest.

## The none bucket

| Theme | Count | Example |
|---|---|---|
| Specification or plan consistency | 38 | Two sections of one plan give different figures for the same baseline. |
| Documentation errors | 13 | An unescaped bar splits a table cell. A shell snippet does not run as written. |
| Copy and wording accuracy | 7 | A message says a manager was told, when delivery may have failed. |
| Accessibility | 4 | State is shown by colour alone. Focus is lost after a sort. |
| Dependency or configuration hygiene | 1 | A workflow exception is removed too early. |
| Style, naming, performance, simplification | 0 | None in this sample. |

Specification consistency is 22% of the sorted sample, and it comes from one repository that reviews its own specification documents. Style and naming are absent. The sample does not say why. The quiet profile and the repositories' own linters would each remove them.

## Outcomes

The outcome of each of the 199 inline findings was read from its thread. Accepted means the first human reply claims a fix. Dismissed means the reply declines, or says the behaviour is intended.

| Outcome | Count | Share |
|---|---|---|
| Accepted, with a fix claimed | 127 | 64% |
| Dismissed | 14 | 7% |
| Replied otherwise: clarified or deferred | 15 | 8% |
| No reply, thread resolved and outdated | 14 | 7% |
| No reply, thread resolved | 12 | 6% |
| No reply, thread open | 17 | 9% |

182 of the 199 threads are resolved. The bot resolved 141 of them itself. It appended a note naming the fixing commit to 123 of the original comments.

A thread the bot resolved was resolved after a code change fixed the issue. The bot checks the new code, names the commit, and closes the thread. So a bot resolution that cites a fixing commit is evidence the finding was accepted. It is not the bot agreeing with itself. An earlier reading of this sample took the resolved flag to measure only the bot's opinion, and the maintainer of the repositories corrected it. A resolved flag with no fixing commit still says less. In several threads the bot accepts an explanation, no code changes, and it leaves the thread open pending a human decision.

By severity:

| Severity | Findings | Accepted | Dismissed | Other reply | No reply, resolved | No reply, open |
|---|---|---|---|---|---|---|
| Major | 46 | 24 | 7 | 4 | 4 | 7 |
| Minor | 150 | 103 | 6 | 11 | 22 | 8 |
| Trivial | 3 | 0 | 1 | 0 | 0 | 2 |

Major findings are dismissed at 15%, 7 of 46, against 4% for minor, 6 of 150. The severity the bot is surest of is the one authors most often reject.

By category, security findings are dismissed 2 of 10 and stability findings 3 of 15. Functional correctness is accepted 78 of 110. By lens, correctness is accepted 43 of 69, trust boundary 8 of 12 with 3 dismissed, and specification consistency 23 of 38 with 4 dismissed.

The authors in these repositories answer almost every finding, many with a standard reply naming the fixing commit. That is a repository convention. Expect a lower reply rate elsewhere.

## Structure

- Reviews are incremental. The bot reviews the commits since its last review, about four reviews per pull request here. A rate limit stopped a review 12 times.
- A finding on a line the pull request did not change cannot be posted inline. It goes in the review body with its file and lines, and has no thread.
- Nitpicks are review-body only and mostly trivial.
- One walkthrough comment per pull request is edited in place. It carries a summary, a table of changes, a sequence diagram, and pre-merge checks on the title, description, and linked issues.
- The bot answers each human reply. Before it answers it often runs a check over the code. 44 of its 155 replies store a learning. A learning is one sentence recording the decision a human gave when dismissing or clarifying. Later findings cite those learnings.
- When it is wrong, it withdraws the finding in words.

## Mapping to Melian's lenses

| Melian lens | CodeRabbit's nearest category | Evidence |
|---|---|---|
| `correctness` | Functional correctness, with stability and availability | Strong. The bulk of all findings. |
| `contracts` | None of its own | 1 of 172. It checks documents against each other, not the callers of a changed signature. |
| `trust-boundary` | Security and privacy | 12 of 172: authorisation, injection, and escaping, mostly major. |
| `removed-behaviour` | None | 2 of 172, found in passing. |
| `tests` | None | 2 of 172, both about a specification's coverage. |
| `conventions` | Maintainability, through guidelines and learnings | 10 of 172. |
| `design` | None; it borrows from specification text | 3 of 172. It compares code with a specification, not with a decision log. |
| `durability` | Data integrity, and stability and availability | 10 of 172, when the text raises them. |

CodeRabbit has no separate finder for `contracts`, `removed-behaviour`, `tests`, or `design`. Each came up in under 2% of the sorted findings, always in passing.

Melian has no lens for these:

- Specification and plan consistency: two documents that disagree, or a requirement nothing covers.
- Documentation accuracy: commands that do not run, stale walkthroughs, broken tables.
- Copy accuracy: a message a user sees that may be false.
- Accessibility.
- Linter findings from a tool pass, folded into the same list.
- Pull request hygiene: title, description, linked issues.

Performance exists as a category and fired once in 224.

## Caveats

- Four repositories from one maintainer's organisations, one month, and mostly one profile.
- Repository A is dominated by specification review. It inflates both the none bucket and the functional correctness count.
- The outcomes come from a heuristic over the first human reply.
- The lens sorting is one reader's judgement, with no second pass. 27 inline findings were not sorted.
