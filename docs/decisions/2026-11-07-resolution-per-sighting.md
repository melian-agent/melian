# Resolution per sighting

Status: built in milestone 2, step 21, "Resolution per sighting", [issue #230](https://github.com/melian-agent/melian/issues/230).

Amends: [Resolution per lens and per rule, as built](2026-10-13-resolution-as-built.md), the first paragraph of "What this gives up".
Amends: [An unresolved acknowledgement fails the status, as built](2026-10-17-acknowledge-status-exact-rule.md), the paragraph of "What this gives up" on sightings of one finding ID.

## Problem

Two lenses that share a rule ID can sight one finding ID. The findings document merges the sightings into one finding at the highest severity, and adjudication resolved that finding once for each check at that severity. A lens's ceiling or mapping then applied to a severity the lens never reported, and one unjudged sighting capped a sighting the verifier confirmed.

Example: `lens.security` reports `no-eval` at P1 and `lens.style` reports the same line under `no-eval` at P3. The root sets `lens.security: { ceiling: advisory }`. The style lens's P3 is advisory by the table and the security lens's P1 is held at advisory by its ceiling, so neither asks for more. Merged first, the style lens was resolved at P1, and the finding blocked.

## Decision

Each lens's sighting of one ID resolves as its own report, as a report with an ID of its own already does inside a merged defect:

- under its own check, rule, version, and the severity it reported, after any lowering its verifier recorded;
- with its own mapping, its own ceiling, and its own unjudged cap, so a confirmed sighting beside an unjudged one resolves in full;
- leaving out a sighting a verifier refuted while another stands, and counting every sighting when none does.

The finding takes the strictest result, the speaking sighting's on a tie. The floors then apply to the finding, as before.

The two cause caps still read the merged cause: the strongest cause any sighting gave, with its proof, as [the merged defects section](2026-10-13-resolution-as-built.md#merged-defects) sets for reports. Resolving each sighting under its own cause would let a merge lower what blocks. Example: one lens sights an old P0 that nothing ties to the change, and another lens sights the same ID as introduced at P3. Each under its own cause resolves `advisory`; the merged finding is an introduced P0 and blocks. Sightings and reports follow one rule.

The per-sighting severity comes from the claims the findings document already keeps: since step 29, each sighting's claim holds its reported severity in `otherClaims`, beside its own verification. No stored shape changes. A finding that lacks a claim of its own ID for every producer it lists, as one stored before claims kept their severity, resolves every producer at the merged severity, the stricter reading it had before.

## Why

A lens's policy is a statement about that lens's findings. Applying it to another lens's severity, because the two chose the same rule ID, decides one lens's report under another's terms. The same holds for the unjudged cap, which the as-built decision already applies per report.

## What this gives up

Static, guardrail, and mutation checks never share an ID with a lens or with each other, since their rule IDs carry their own prefixes, so only lens sightings are split. A static check's two versions at one revision cannot coexist: a check replaces its own sightings of any version.
