# A round replaces no round until issue #395 decides who may

Amends: [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md), rule 4's list of the earlier rounds of its revision a round replaces, and standing computed from that list

Status: for [issue #425](https://github.com/melian-agent/melian/issues/425). The maintainer ruled on 2026-11-16, in the coordinator's session, answering "agree" to option D below, which the coordinator put and recommended.

## Problem

Rule 4 has a round name, in `replaces`, the earlier rounds of its revision it replaces, and a round stands when no round that counts names it there. [Issue #395](https://github.com/melian-agent/melian/issues/395) has not yet decided who may replace what. The first export wrote every round already in the store at the revision into `replaces`.

Example: host A's round blocks on a failed guardrails check. Host B reviews the same head later and finds nothing. B's round lists A's round in `replaces` though B never read A's records. Today a reader shows every round, so nothing changes. Once issue #395 gives `replaces` standing, B's round would hide A's block, and records are immutable, so B's list could never be taken back.

## Choice

- A, as first built: name every round already stored.
- C: name only this writer's own rounds, which needs a writer ID that records do not carry.
- D: name nothing until issue #395 decides who may replace what.

The maintainer chose D. Every round's `replaces` list is empty, and `ReviewRecords.round` still takes the list, so issue #395 can fill it without a new payload version. A reader shows every round of the revision, ordered by ID.

## Why

Records are immutable. A list naming rounds the writer never read would hand issue #395 data it had to distrust, and no later rule can remove it from the store.
