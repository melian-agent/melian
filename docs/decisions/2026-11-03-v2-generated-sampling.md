# Version-2 samples select generated probes and retain ignored notes

Amends: [mutation evidence](2026-10-24-mutation-evidence-by-enumeration-and-verification.md), version-2 classification and sampling of ignored rows

Problem: the sampler required invented claims for policy exclusions and head disables. It then let those claims satisfy probe groups and quotas.

Example: an ignored new-test row shared a mutator with a generated kill. Its mandatory selection could stand for that mutator while testing no generated change.

Only version-2 generated rows require `claim`, `evidence` and `survivorClasses` for sampling and future verification. Only generated rows enter mandatory new-test/equivalence, per-class, per-mutator and per-file groups, then each file’s remaining fifth. Identity tuples, hash order, group order, quotas and rounding stay unchanged.

Keep every ignored row in the raw inventory with its exact status, provenance, reason and any valid optional claims. Do not invent claims. Supplied malformed fields, claims or evidence still refuse. Samples add `ignored: { config: MutationInventoryRow[], comment: MutationInventoryRow[] }`, even when empty. Each note is an owned full-row copy. Config denotes policy exclusions; comment denotes unresolved head disables and covers nothing. Notes enter no quota. `selected` contains generated probes, `total` counts the complete source inventory, and `unmutated` stays unchanged.

Version 1 retains its historical validation, output shape and sampling, including ignored-like labels. The version-2 stored schema and version remain unchanged. Only sample output gains notes, through both the CLI and compatibility route. `forVerification` remains version-2-only and refuses incomplete or generated-unclassified inventories. It runs no verifier. Verification, cache, protocol and language changes remain deferred.
