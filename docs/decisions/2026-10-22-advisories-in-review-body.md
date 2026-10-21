# Advisories belong in the review body

Status: accepted by the maintainer, 2026-10-22.

Amends: [Owed-thread returns](2026-10-18-owed-thread-returns.md), advisory placement and thread reuse.

## Problem

The step-10 rehearsal published a real review on [pull request #164](https://github.com/melian-agent/melian/pull/164).
Its one advisory finding opened an inline thread.
The main ruleset requires every review thread to be resolved, so the advisory blocked the merge while asking for no action.

## Decision

Publish advisory findings in the review body only, regardless of their line placement.
List each with its file:line linked to the reviewed head commit's blob, its rule and a short summary.
Use the existing link helper, escaping and body limit.
Keep each finding's signed marker and the “Pre-existing, important” label when it applies.

Only acknowledge and block findings may open inline threads.
Their existing placement rules remain: changed lines, the nearest added line, or the body when no line can take a comment.
An advisory raised to acknowledge or block gets a thread when its location permits one.
A finding lowered to advisory retires its old thread through the existing addressed-edit and thread-resolution path.
The finding remains live in the body and the findings document.

Advisories never reclaim an owed thread.
An owed resolution survives a later advisory head and crash recovery.
Reuse the lifecycle from [pull request #155](https://github.com/melian-agent/melian/pull/155); no stored shape or version changes.
