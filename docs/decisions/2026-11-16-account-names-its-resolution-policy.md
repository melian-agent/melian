# An account names the resolution policy its round was decided under

Amends: [the account record decision](2026-11-16-account-record.md), "Where the reader takes its policy"

Status: for [issue #502](https://github.com/melian-agent/melian/issues/502). The amended decision is on the branch of [pull request #476](https://github.com/melian-agent/melian/pull/476), `docs/decisions/2026-11-16-account-record.md`, and lands with it; this file lands after it. The maintainer ruled on 2026-11-16, in the coordinator's session, that #476 leaves the gap and this issue closes it before build 4 of the shared record. Where the field goes, that it needs no version, and that it joins the key are the coordinator's answers of 2026-11-16, not rulings.

## Problem

A reader of exported records takes the resolution policy from the source the review read. For a range whose head is checked out, that is the working tree, which can change after the review.

Example: a range review blocks on a P2 finding. Someone edits `melian.yaml` to make P2 advisory. `melian findings --records dir:<path>` decides the same round under the new file and prints a pass, and nothing says the verdict differs from the review's. Once records reach other machines, a second machine's working tree can hold another policy without anyone choosing to re-decide.

## Choice

The account, not the round, names the policy. A round's payload is core's manifest, fixed by rule 4 of [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md). The account is where a round's policy facts already live, and the round's key holds the account's ID, so the policy binds the round too.

The account's payload gains `resolutionPolicy`: the fingerprint `configsFor` gives, the one the adjudication task's input holds and `dismiss` uses to refuse a stale re-decision, or `null` when the review read no policy source. No second fingerprint is derived.

The field joins the account's key, so two reviews of one range under two policies write two accounts, and a fingerprint and `null` key apart.

A reader computes the fingerprint for the round's findings under its own policy source and compares. A round reads not reviewed, naming both sides, when they differ, when the account names a fingerprint and the reader has no policy source, or when the account names `null` and the reader has one.

The payload stays at version 1. Only #476's build writes an account, and nothing on `main` does, so no stored account lacks the field. That holds only while nothing that writes an account has shipped; the pull request for this issue checks it again when it merges `main`.
