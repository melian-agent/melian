# Issue #496: the record classes name a dismissal's dismisser and reason

Melian's round on [pull request #524](https://github.com/melian-agent/melian/pull/524) found two gaps in the outside-text decision's wording, with no behaviour behind either.

- Finding 91be4b22a88d53d4: the decision's list of string classes left out a dismissal's `by` and `reason`, which a writer wrote through `melian dismiss`. The list is now seven classes, checked field by field against `packages/core/src/record-payloads.ts`, and the decision says it leaves rule 7 of the decision it amends as it is. A test in `packages/pipeline/test/review-records.test.ts` gives every dismissal field a class and asserts that only the dismisser and reason carry writer text. Setting either to `withheld` in `ReviewRecords` fails it.
- Finding 62a76793e701df06: `docs/design.md` said nothing in the store is secret without naming the withheld text. It now links the decision. `docs/guidelines/pipeline.md` lists the seven classes.

The inventory found two tool-written fields the classes do not hold to a pattern: a static check's `version`, read from the installed tool's `package.json`, and Enola's snapshot ID, receipt and cache key. The decision names them as limits.
