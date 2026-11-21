# Issue 561: other probe lenses are measured on misses only

[Pull request #550](https://github.com/melian-agent/melian/pull/550)'s round 44241903552 found that `MELIAN_EVAL_PROBE_LENSES` accepted any lens over the goldens, which hold only trust-boundary's probing defects. A run naming `correctness` scored it on trust-boundary's corpus, where trust-boundary's committed probe could earn the recall.

The coordinator chose the restriction on 2026-11-18, as a choice of approach. The probing measurement now exits 2 for any probe-lens list but `trust-boundary` unless `MELIAN_EVAL_PROBE_SET=misses`, and its message says so. The parity run uses misses, so nothing planned needs the removed path. The tests of an in-review probe-lens refusal and of the shared prober tier now run on a whole-mode miss. A lens's refusal for a tier that does not run it stays tested on `ProbingCombination.routed`.

Two new settings cases fail without the rule: `correctness` alone, and `trust-boundary,correctness` with misses but the default set. Each decides one operand of its condition, and the misses-only settings case keeps `set !== "misses"` from being forced true.
