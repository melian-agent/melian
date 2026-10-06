# Preserve executable paths during concurrent publication

Supersedes: 2026-10-06-tool-cache.md (publication and repair only).

Two downloads can both see an invalid destination. Deleting it before rename can then delete the executable the other run just returned.

Publish complete downloads into unique entry directories below the pin. Verify each before returning its path. Reuse a verified winner when present. Repair publishes another entry and never removes the old one. Earlier direct-layout entries with retained archives remain readable. Corrupt entries remain misses.

Unique destinations remove the shared repair operation, so no persistent lock or crash recovery for a lock is needed. Two overlapping downloads may retain two archives. Pruning remains deferred; it must account for active executable paths.
