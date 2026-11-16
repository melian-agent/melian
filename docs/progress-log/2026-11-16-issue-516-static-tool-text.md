# Shared records carry no static tool's text

[Issue #516](https://github.com/melian-agent/melian/issues/516) keeps Enola's and the mutation check's own text out of the records a review exports. It builds on [issue #496](https://github.com/melian-agent/melian/issues/496)'s work, which withheld outside text from every other field of a record and named this gap.

`ReviewRecords` now rewrites each static finding in a record's sightings, and a dismissal's sighting, to a fixed sentence naming its check and rule, unless the check is Biome or tsc, whose findings hold a fixed sentence already. It keeps the rule, place, snippet, trigger and ID. Enola's receipt keeps only the three fields Melian checks. In core, an Enola or mutation result with no code to go by takes a hash of its message as its discriminator, in place of the message itself, so the stored ID input holds no tool text. Such an Enola finding gets a new ID once, so its dismissal reopens once. [The decision](../decisions/2026-11-16-shared-static-findings-carry-no-tool-text.md) records why.

`packages/pipeline/test/review-records-static-text.test.ts` was written first and failed on every case at 44db99f9, the merge of #496's branch into `main`, for the reason the issue gives: the made-up token reached the record's bytes, and the discriminator. It passes after the fix.
