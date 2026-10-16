# A nested melian.yaml that changes what blocks draws the notice whatever the parent says

Choice, agreed by the maintainer on 2026-10-16: a change to any key of a `melian.yaml` that decides what blocks below it is itself a policy-change notice, at `acknowledge` at least, whatever the directory above switches. This is plan step 30, "Nested policy keys force the notice". Nothing of the new part is built yet.

## The problem

A nested `melian.yaml` is judged under the directory above it. A base file there may set `guardrails.policy-change-review.enabled: false`, and then a change to the nested file draws nothing. A nested file can change what blocks below it without touching `resolution`.

Example: `docs/melian.yaml` at the head sets `guardrails.forbidden-paths.severity: P3` and `lenses.correctness.enabled: false`. Findings under `docs/` stop blocking. The root has switched the review of policy files off for `docs/`, so the pull request shows no notice. Under a required status, a head could lower its own blocks in a subdirectory.

## What already holds

[Step 18](../design-implementation-plan.md) built the `resolution` half. A change to any `resolution` key in any `melian.yaml`, or to a lens's declared resolution in any `LENS.md`, always draws the notice. Melian parses the value at the base and at the head with its own loaders, and a side that does not parse counts as changed. The notice is marked `resolution: true`, resolves through the files' tables and its class's entries, and never falls below `acknowledge`. A change to any `melian.yaml` that the switch leaves on is also floored at `acknowledge`. A pull request is judged under its base's keys. The root file's notice is forced on.

## What is new

The same forced notice, by the same comparison of parsed values at base and head, for every other key that decides what blocks:

- `guardrails`, the whole subtree: `enabled`, `severity`, `analyserSeverity`, `rules` and `files`. Changing `policy-change-review.enabled` is one of them.
- `lenses.<name>.enabled`, `paths` and `level`, which decide whether a lens runs on a path.
- Every `static.<tool>` key: `enabled`, `severity`, and the keys that narrow coverage, such as `tsc.project` and `mutation.maxLines`. A key is in the set when changing it can reduce what a check reports.
- `tiers` and `stages`, which decide what runs at all.

The notice carries its class, so resolution keys it apart from the `resolution` notice. It never falls below `acknowledge`, and no entry under `guardrails` lowers it, as for the `resolution` notice. A key that changes no blocking, such as `publish.walkthrough`, `models` and `knowledge`, keeps its place under the parent's switch. The step writes the exact list from the schema and fails a test when a new key lands unclassified.

Under [the acknowledge decision](2026-10-16-acknowledge-fails-the-status.md), the notice also fails the status until a maintainer dismisses it.

## What it changes in design.md

The paragraph that closes the gap names the new keys beside `resolution`, and says which keys stay under the parent's switch. The key table in the core guideline marks them.
