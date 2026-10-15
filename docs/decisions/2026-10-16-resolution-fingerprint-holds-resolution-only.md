# The resolution fingerprint holds what decides resolution

Refines [resolution as built](2026-10-13-resolution-as-built.md), the clause "A task decides only under the policy its review read". It replaces no clause.

Problem: the adjudication task refuses to record a verdict when its policy fingerprint differs from the one the review read. The fingerprint listed each lens variant under its version, and a lens version hashes everything the lens runs with, its budget included.

Example: a review ran with an uncommitted `.melian/lenses/correctness/LENS.md` that extended the built-in lens to raise its budget, and an uncommitted `melian.local.yaml` that named models only. Both were removed afterwards. `melian dismiss` then refused on five findings with "the resolution policy changed", though nothing that decides resolution had changed. Only the lens file did it: the preference file's models never reached the fingerprint.

Choice: the fingerprint covers only what the resolution walk reads.

- every path's merged `resolution` table, each file's own `resolution` layer (so `checks`, `ceiling`, and `preExisting` among them), and `ruleAliases`;
- each lens's declared `resolution` as effective at the path, after `extends`;
- each lens variant the source defines, by name, scope, and declared `resolution`, in place of its version.

A budget, a model route, a tier, a lens body, or a band changes none of these, so a dismissal after such a change decides the verdict again. A `resolution` key in any layer, a rule alias, or a lens's declared resolution, wherever its file sits, still refuses.

The cost: a report whose variant version no longer exists, because the lens file that made it was removed, resolves through the nearest lens's default. When the removed file changed only the budget, that default is the same. When it changed the declared resolution, the fingerprint differs and the dismissal still asks for a fresh review.

The refusal message named the remedy twice, once in the task's error and once in `dismiss`. The task's error now states the cause alone and `dismiss` adds the remedy.
