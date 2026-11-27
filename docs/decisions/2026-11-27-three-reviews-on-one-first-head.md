# The three reviews run first on one head

Status: proposed by the coordinator on 2026-11-27 for the maintainer's ruling. The maintainer asked for the draft that day, in the coordinator's session; it is not a ruling until he agrees this pull request.

## Problem

Every pull request gets Codex's adversarial review, a Melian round and the Claude review of record. AGENTS.md ran them one after another: Codex first, then its fixes, then a round, then its fixes, then the review of record. Each reviewer saw different code. A defect Codex found was fixed before Melian's round ran, so the round could neither find it nor miss it.

Example: the maintainer's parity loop needed to know which defects each reviewer finds. For the three pull requests it measured, [#613](https://github.com/melian-agent/melian/pull/613), [#619](https://github.com/melian-agent/melian/pull/619) and [#623](https://github.com/melian-agent/melian/pull/623), the coordinator had to run each reviewer again, blind, on one old head, and build each defect list by hand. About forty pull requests merged between 2026-11-04, the date of the newest comparison record, and 2026-11-27 with all three reviews posted and nothing that could compare them.

## Choice

The three reviews run first on one commit: the first head the builder pushes with its gate green. The builder starts all three together, pushes no fix until all three have reported, and names the commit in its report as the first reviewed head.

After that head nothing changes. Each fix pass gets a Melian round, and the rules for when Codex's review and the review of record run again stand.

After the merge, the coordinator has a Sonnet agent write the pull request's defect list for its comparison record: each distinct defect a reviewer raised on the first reviewed head, who raised it, and the commit that fixed it or the builder's answer disputing it. A finding that a later commit fixed, with a failing test first, counts as real. The coordinator spot-checks a sample.

## Why

- The fix commits are an answer key nobody has to write. AGENTS.md already requires a failing test before a fix, so a fixed finding was a real defect at the head the test failed on.
- All three reviews already run, so the comparison costs only the defect list, about a dollar a pull request.
- Starting the three together is faster than running them in turn.
- Ten such pull requests are also the window [the shadow retirement rule](2026-10-06-shadow-retirement-merged-window.md) asks for, measured on like for like.

## What it costs

- A defect one reviewer finds is no longer fixed before the next reviewer runs, so two reviewers may report it. The comparison record already counts a defect once however many report it.
- The first round reviews a head no review has improved, so it may raise more findings than a first round does today.
- Only the first head is compared. Later rounds on fix commits stay uncompared, as they are now.

## What does not change

The review of record's brief, its independence and its model. Who runs each review. The rules for marking a pull request ready and queueing it.
