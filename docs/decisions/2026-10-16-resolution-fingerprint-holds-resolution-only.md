# The resolution fingerprint holds what decides resolution

Refines [resolution as built](2026-10-13-resolution-as-built.md), the clause "A task decides only under the policy its review read". It replaces no clause.

Problem: the adjudication task refuses to record a verdict when its policy fingerprint differs from the one the review read. The fingerprint listed each lens variant under its version, and a lens version hashes everything the lens runs with, its budget included.

Example: a review ran with an uncommitted `.melian/lenses/correctness/LENS.md` that extended the built-in lens to raise its budget, and an uncommitted `melian.local.yaml` that named models only. Both were removed afterwards. `melian dismiss` then refused on five findings with "the resolution policy changed", though nothing that decides resolution had changed. Only the lens file did it: the preference file's models never reached the fingerprint.

Choice: the fingerprint covers only what the resolution walk reads.

- every path's merged `resolution` table, each file's own `resolution` layer (so `checks`, `ceiling`, and `preExisting` among them), and `ruleAliases`;
- each lens's declared `resolution` as effective at the path, after `extends`;
- for each lens report, the declared `resolution` it resolves through: the one its variant maps to, or the nearest lens's where the variant is no longer defined. The variant's version is no part of the fingerprint.

A budget, a model route, a tier, a lens body, or a band changes none of these, so a dismissal after such a change decides the verdict again. A `resolution` key in any layer, a rule alias, or a lens's declared resolution, wherever its file sits, still refuses.

The cost: a lens that no finding of the review reports through adds nothing beyond its default at the path, so a variant in a folder no finding sits under can change without refusing a dismissal, as it changes no resolution.

The refusal message named the remedy twice, once in the task's error and once in `dismiss`. The task's error now states the cause alone and `dismiss` adds the remedy.

The new recipe gives another value for the same policy, so a task input an earlier build stored would refuse every dismissal after an upgrade. Choice: the fingerprint now starts `2:`, and the check accepts either that or the value the first recipe gives the current policy, kept as `legacyFingerprint`. A stored input needs no migration and no new field; a review from the earlier build decides again when its policy is unchanged and refuses when it changed. The first recipe still hashes the version-keyed variants, so such a review keeps the old refusal for a removed budget override. Drop `legacyFingerprint` once no stored review predates the change.
