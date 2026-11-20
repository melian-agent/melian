# Added owned rounds follow the order they were minted

Status: the maintainer ruled on 2026-11-21, in the coordinator's session, that [pull request #613](https://github.com/melian-agent/melian/pull/613) may amend the offline export decision this way: "absolutely amend, stable order is it". [The pull request records it](https://github.com/melian-agent/melian/pull/613#issuecomment-7040616077).

Amends: [offline export follows stored ownership](2026-10-27-offline-export-stored-ownership.md), the order of added owned rounds.

## Problem

That decision says new owned attributed records follow saved members "in round-ID order". The aim was a stable order for rounds added after the snapshot, the same on every export. Comparing round IDs as text does not give the order the rounds ran in.

Example: a pull request's store gains rounds `range-aaaaaaaaaaaaaaaa.r9`, minted at 09:00, and `range-aaaaaaaaaaaaaaaa.r10`, minted at 10:00. As text, `r10` sorts before `r9`, so an export lists the later round first. `melian compare misses` keeps the last round's result for a finding compared in both, so it would keep r9's answer over r10's.

## Choice

Added owned rounds follow saved members by mint time, then by ID, as `byMinting` in the pipeline orders them when membership numbers rounds. The order stays stable and agrees with the order the rounds ran. Saved members keep their snapshot order, and raw records keep theirs.

## What it costs

Two rounds minted in the same millisecond still fall back to text order of their IDs. Membership numbering accepts the same tie.
