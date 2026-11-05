# Run details belong to a review round

Status: accepted by the maintainer, 2026-10-27, in [fix pass 3 on issue #213](https://github.com/melian-agent/melian/issues/213#issuecomment-6431755745).

Amends: [Run details from stage telemetry](2026-10-25-run-details-from-telemetry.md), when the projection is captured and how publication selects it.

## Problem

A revision can have a decided review followed by a rerun that fails before deciding. Reading telemetry by revision then gives the failed rerun's checks and spend beside the earlier verdict. Keeping only the earlier spans does not bind the rest of the run. Reading before publication captures its round also lets a later round receive an earlier run.

## Decision

Store each completed review's run snapshot under its storage-local round ID. Carry that ID in `StoredRunDetails`. Capture only while the round owns its adjudication, checks and preparation record. Bind the host's spans to the round whose adjudication it started or attached to.

Publication requests the run of the round it captured, then validates that round again before posting. A supplied run must carry the same ID. The publish task checks the ID on replay too. A later publish that cannot read the snapshot keeps an earlier ledger run only for that same round. A round without a bound snapshot omits the table, including older unbound records.

The version-1 `melian.run-details` document family stores snapshots by round ID. Existing task and document versions stay unchanged. Detached `melian telemetry` still reads stages by revision. Snapshot capture and publication ask no model.
