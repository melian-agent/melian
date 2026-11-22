# Prune lists a valid miss's evidence once 90 days old, and removes it only once a write cannot race the removal

Amends: [2026-11-20-miss-evidence-is-kept.md](2026-11-20-miss-evidence-is-kept.md), for the 90-day prune and the issue its budget refusal names

Recorded by a builder agent on 2026-11-20 for [issue #627](https://github.com/melian-agent/melian/issues/627). The maintainer agreed on 2026-11-21, in the coordinator's session, that prune removes evidence older than 90 days by write time, planned by default and removed only with `--apply` ([the record](https://github.com/melian-agent/melian/issues/627#issuecomment-7052775885)). That removal arriving in two steps, with this one listing and removing nothing, is the coordinator's answer on approach, not a ruling.

## Problem

[The store retention decision](2026-11-14-store-retention.md), section 3, accepts prune's races between its plan and each removal only because everything prune removes is cache, and asks for an exclusion before it removes anything durable. Evidence is durable.

Example: a maintainer adjudicates a new valid miss in a round last written 91 days ago, at the moment prune checks the round's age. Prune then renames the round away, and the evidence just written is lost, though the adjudication stays recorded.

No exclusion exists that fits. Core's `Lease` has no store in the state directory, the mutation cache's lock treats a lock as stale by age because losing it costs only speed, and nothing else in the store excludes a writer. [Issue #633](https://github.com/melian-agent/melian/issues/633) builds the local lease store that [the coordination decision](2026-11-08-how-melian-coordinates.md)'s rule 2 plans.

## Decision

1. `melian store prune` lists, in `agedEvidence` and in its output, each round folder `evidence/<changeset>/<round>/` whose newest file was written more than 90 days before the plan, with its size. A folder at exactly 90 days is kept. The round is the unit, so a pointer never outlives its stages.
2. A name under `evidence/` that is not a changeset ID, or under a changeset that is not a round's local name, or that is a link or a file, is listed as not recognised, as prune lists any other.
3. `--apply` removes none of it, and the output says so and names [issue #633](https://github.com/melian-agent/melian/issues/633). Rule 8 of the amended decision, that prune never removes evidence, holds until that issue lands, amends the retention decision for evidence, and turns removal on.
4. The budget refusal and `melian doctor` name [issue #633](https://github.com/melian-agent/melian/issues/633) in place of [issue #627](https://github.com/melian-agent/melian/issues/627) as what lets prune remove evidence. The refusal now reads, after `evidence.budget is <budget>. `, `melian store prune keeps evidence, and lists what is more than 90 days old. Raise evidence.budget in your configuration until issue #633 (https://github.com/melian-agent/melian/issues/633) lets prune remove it. This refusal wrote no file and lost no evidence already kept`.

## What this gives up

- The evidence directory still grows until [issue #633](https://github.com/melian-agent/melian/issues/633) lands, and the budget stays its only bound. Prune's listing tells a maintainer how much a removal would free.
