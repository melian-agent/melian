# Records written before Melian withheld outside text are refused

Amends: [An account names the resolution policy its round was decided under](2026-11-16-account-names-its-resolution-policy.md), records written before Melian withheld outside text

Status: the maintainer ruled on 2026-11-18, in the coordinator's session, on the design lens's blocking finding 00f639cb91957379 on [pull request #551](https://github.com/melian-agent/melian/pull/551): the finding is dismissed, and this pull request amends the decision it cites, with no new payload version. The coordinator recorded the ruling [on the pull request](https://github.com/melian-agent/melian/pull/551#issuecomment-6969231962).

## Problem

The amended decision says a version-1 account still parses, so a record set that holds one does not fail its checks, and its round reads not reviewed. [The classed-fields decision](2026-11-17-shared-record-classes-checked-on-read.md) tightens the version-1 payloads without a new version, and some records an older build wrote no longer pass.

Example: `main` at `4d08b08c` wrote the records in `packages/pipeline/test/fixtures/account-v1/`, before the producer withheld outside text. A verification record there holds an unanswered candidate's reason as the provider's text, where a code is now required. Its payload check refuses it, so the record set fails its checks, and every round in that store reads as failing them, not only the round the record belongs to.

## Decision

A record written before Melian withheld outside text is refused by the payload checks, whatever its kind, and is not read as version 1. A store that holds one reads as failing its checks until the record is removed. A version-1 account whose records pass reads as the amended decision says: it parses, and its round reads not reviewed, saying the account was written before accounts named their resolution policy.

No shared store holds such a record: `melian/state` holds nothing yet, and those builds wrote records only to a host's own store and to test fixtures. `packages/pipeline/test/recorded-round.test.ts` reads the `account-v1` fixture and expects its round to fail its records' checks. It reads the version-1 refusal from a round in the `e6ed960bd` capture, whose records pass.
