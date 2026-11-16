# A shared record carries no text a tool, a provider or the head wrote

Status: the coordinator's answer of 2026-11-16 on [issue #496](https://github.com/melian-agent/melian/issues/496), on approach. It extends [Melian stores no Biome or tsc text](2026-11-06-static-configuration-stays-in-the-checkout.md) to every record Melian exports. It is not a maintainer's ruling.

Amends: [Hosts share a record of facts behind a store port](2026-11-13-shared-record-behind-a-store-port.md), rule 2: a record holds the facts below, never another writer's text.

It leaves that decision's rule 7 as it is: a dismissal record keeps its dismisser and its reason, which rule 7 has a reader show.

## Problem

Records leave the reviewing host: other hosts and the merge-group check read them. Melian's local store holds whatever a check, a lens or the verifier reported when it did not finish. Until now the export copied that text into the record.

Example: a failed check's record kept `error`, which `failure()` in `packages/pipeline/src/checks.ts` fills from the thrown error's message. Stryker's message embeds the tail of its log, and Enola's embeds the tool's stderr. A head whose tests print a login sends it through that message into a record any reader of the store can fetch. The same path ran through a skipped or provisional check's reason, a check's notes, a lens's or a verifier's reason and error when a provider failed, a lens's caveats, and a triage failure.

Stripping one field leaves the next. The rule has to hold for every kind before records leave the machine.

## Decision

Each string field of an exported record is one of seven things. The list comes from an inventory of every string field in core's payload schemas, `packages/core/src/record-payloads.ts`, kind by kind: check, lens, verification, walkthrough, triage, telemetry, dismissal, account and round.

1. An ID, key, hash or commit: a record's ID, a finding's ID, a request key, a trigger's hashes, a revision's commits, and the snapshot ID, receipt and cache key Enola mints for a graph.
2. A time Melian stamped: a dismissal's `at`.
3. A code from a closed set Melian defines: a status, a skip's cause, a `CheckErrorCode`, a severity, a scrutiny level, a budget that ended, a telemetry stage's outcome, and the source of a route in a lens's lineage.
4. A name Melian or the base's configuration gives: a check's or a lens's name, a lens's version, a stage's name, a model and the route it came by, a triage decider, and a question set with its version, questions and options.
5. A path in the repository.
6. The review's content: a finding's own text, as the lens or verifier wrote it, a verifier's verdict on a claim, and a walkthrough.
7. A dismissal's dismisser and reason. A writer wrote both, through `melian dismiss`, and the record keeps them because rule 7 has a reader show each standing dismissal's reason. No other field takes a writer's text, and no other record kind holds a dismisser or a reason of a dismissal.

Under class 6, the review's content is a finding's text, and a walkthrough's `summary`, per-file `summary`, `diagram` and `note`. A model wrote each from the change it was shown, through the same revision readers a lens uses. So a head can steer that text, and the text can quote the head, as a finding's text can. A reader of a shared record treats it as a finding's text: the change's content, never an instruction and never a fact Melian vouches for. `test/review-records-withheld.test.ts` pins the walkthrough fields a record exports, so a new field fails to compile until someone decides it.

`ReviewRecords` in `packages/pipeline/src/review-records.ts` applies it at the one place every record is built:

- A failed check's `reason` is its code when the code is a `CheckErrorCode`, a task outcome's status, or `no record`; any other code becomes `unexpected`. Its `error` is Melian's fixed sentence, `withheld`: "Melian shares none of this text, which the reviewing host's store and terminal hold". The sentence holds no "; ", since a reader splits a lens's reason into notes there.
- A skipped or provisional check's `reason`, and a lens's or a verifier's decided `reason` and `error`, are the code when it is one, and `withheld` otherwise.
- A check's `notes` are empty.
- A lens's `caveats` keep Melian's two fixed caveats, `blindCallers` without its detail and `lightTriage`. Any other caveat becomes `withheld`.
- A lens or verifier candidate that did not answer, or gave up, records `withheld` as its reason.
- A triage failure records `withheld`.

The full text stays in the reviewing host's own store and terminal. No verdict changes: a verdict decides from a check's name and status, and from which skips the account allows, never from a reason. A reader shows less: where it printed a stored reason, an `Error:` line or a caveat's detail, it prints the fixed sentence. The tests that hold a reader's verdict to the host's, through `test/fixtures/shared-verdict.ts`, still compare every other field whole, and allow only that sentence, or `blindCallers` for a caveat, where the host kept text.

`packages/pipeline/test/review-records-withheld.test.ts` holds the class shut. It feeds a made-up token through every input of every record kind that takes outside text, and asserts no record's bytes hold it. A new field that copies outside text fails it.

## What this gives up

A reader of another host's round cannot see why a check did not run, beyond its code and `cause`. It reads the reviewing host's terminal or store for that.

A sighting keeps a finding whole, and a finding Enola or the mutation check reported keeps the message its tool wrote, so a check record's `sightings` can still carry that tool's text. Biome and tsc findings carry Melian's fixed sentence already. [Issue #516](https://github.com/melian-agent/melian/issues/516) closes the gap before records leave the machine.

A static check's `version` is what the tool's installed `package.json` says, read by `staticToolVersion` in `packages/pipeline/src/static.ts`; for a tool from the checkout, the checkout's install wrote that file, so it is the head's text. A record carries it only when it is a version in its own form, which `valid` from the `semver` package decides, or Melian's `unavailable`; anything else reads as the fixed sentence. That bounds the field's shape, not its whole content: a pre-release or build tag such as `1.0.0-<letters>` is a valid version, so a head can still put a short run of letters, digits and hyphens there.

Enola's snapshot ID, receipt and cache key are Enola's own output, which the schema bounds only as non-empty text. They should be held to their hash patterns before records leave the machine.
