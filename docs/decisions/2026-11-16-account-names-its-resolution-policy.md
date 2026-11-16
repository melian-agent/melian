# An account names the resolution policy its round was decided under

Amends: [the account record decision](2026-11-16-account-record.md), "Where the reader takes its policy"

Status: for [issue #502](https://github.com/melian-agent/melian/issues/502). The amended decision is on the branch of [pull request #476](https://github.com/melian-agent/melian/pull/476), `docs/decisions/2026-11-16-account-record.md`, and lands with it; this file lands after it. The maintainer ruled on 2026-11-16, in the coordinator's session, that #476 leaves the gap and this issue closes it before build 4 of the shared record. Where the field goes, that it joins the key, that the payload moves to version 2, and that a `null` never matches are the coordinator's answers of 2026-11-16, not rulings.

## Problem

A reader of exported records takes the resolution policy from the source the review read. For a range whose head is checked out, that is the working tree, which can change after the review.

Example: a range review blocks on a P2 finding. Someone edits `melian.yaml` to make P2 advisory. `melian findings --records dir:<path>` decides the same round under the new file and prints a pass, and nothing says the verdict differs from the review's. Once records reach other machines, a second machine's working tree can hold another policy without anyone choosing to re-decide.

## Choice

The account, not the round, names the policy. A round's payload is core's manifest, fixed by rule 4 of [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md). The account is where a round's policy facts already live, and the round's key holds the account's ID, so the policy binds the round too.

The account's payload gains `resolutionPolicy`: the fingerprint `configsFor` gives, the one the adjudication task's input holds and `dismiss` uses to refuse a stale re-decision, or `null` when the review read no policy source. No second fingerprint is derived.

The field joins the account's key, so two reviews of one range under two policies write two accounts, and a fingerprint and `null` key apart.

A reader computes the fingerprint for the round's findings under its own policy source and compares. A `null` never matches, on either side. Problem: a first form compared the two values, so an account naming `null` agreed with a reader holding no source. Example: a review with no source records `null`; a reader with no source, or with a checkout and no source, then decided the round under its own `config`, whatever that held. The `null` stood both for "no policy" and for "any policy", the identity guideline's failure of one thing with two keys. Solution: a round reads not reviewed, saying why, when the account names `null`, under any reader; when the reader lacks a checkout or a policy source, or holds only one of them, since it then has no policy to decide under; and, naming both fingerprints, when the two differ. No fingerprint of the reader's `config` stands in for a policy source.

The payload moves to version 2, which requires the field. [Pull request #476](https://github.com/melian-agent/melian/pull/476) merged at `4d08b08c` writing version-1 accounts with no field, so stored accounts lack it. A version-1 account still parses, so a record set that holds one does not fail its checks, and its round reads not reviewed, saying the account was written before accounts named their resolution policy. `packages/pipeline/test/fixtures/account-v1/` holds the records main wrote at `4d08b08c`.
