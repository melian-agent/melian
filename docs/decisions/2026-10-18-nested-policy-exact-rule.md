# Nested policy changes: exact rule for attacking review

Supersedes: [2026-10-16-nested-policy-keys-force-the-notice.md](2026-10-16-nested-policy-keys-force-the-notice.md)

Proposed for plan step 30, phase 1. Implementation waits for an attacking review of this rule.
The tests run against unchanged production code. This decision does not claim that the new rule is built.

## Problem

A nested `melian.yaml` is judged under the directory above it.
A base file there may switch `guardrails.policy-change-review.enabled` off.
Changing a nested guardrail severity or disabling a lens then raises no notice, unless `resolution` also changes.

For example, a head sets `services/pay/melian.yaml` to `lenses.correctness.enabled: false`.
The root has disabled policy notices below itself. The current review uses the base's lens selection.
After merge, later reviews lose that lens without a maintainer having answered a policy notice.
F5 of the attack on [pull request #142](https://github.com/melian-agent/melian/pull/142) identifies this gap.

## Scope: protect by default

Every parsed key of a committed `melian.yaml` is protected, except these exact value paths:

- `publish.walkthrough.enabled`, `publish.walkthrough.collapsed`, and `publish.walkthrough.diagrams`.
- `knowledge.writeBack`.
- Each existing model tier's `model`, `fallbacks`, `accept`, `unavailable`, and `acceptOverridden`.
  The tier names are exactly `light`, `medium`, `heavy`, `decision`, and `verifier`.

An exemption covers that value alone, including an array as a whole. It does not exempt its parent object or future siblings.
The loader still refuses model policy keys in nested files. An invalid file receives no exemption.
Root notices remain forced even for exempt edits.

This replaces the earlier decision's fixed inclusion list with a closed exemption list.
A future schema key is protected without a classification edit. A new exemption needs a reviewed decision.
The schema test must reject stale exemptions and prove that every accepted value path outside them defaults to protection.
It must not require a new key to be added to an inclusion list before protection applies.

In particular, protection includes:

- The whole `guardrails` subtree: switches, severities, analyser severity, rule definitions, messages, patterns, paths and extra files.
  This includes `guardrails.policy-change-review.enabled` itself.
- Every `lenses.<name>` key, including `enabled`, `paths`, both `level` ends, and `tier`.
- Every `static.<tool>` key, including switches, severity overrides, timeouts, `tsc.project`, and `mutation.maxLines`.
- `tiers` and `stages`, including tier membership, check order and stage mappings.
- `resolution`, `checks.allowSkip`, `ruleAliases`, `decisions`, `triage`, `trust`, and `comparison`.

The last group includes root-only keys. Protection does not make them valid in a nested file.
Some accepted nested settings are currently consumed only at the root, including static settings.
They still draw the notice. Step 30 does not change where any setting takes effect.
Conservative notices avoid a second list that must track which caller consumes each key today.

## Compare each file's declarations through the loader

For each changed `melian.yaml` path, compare its own parsed layer at the revision's base and head.
Use the configuration loader's parser, schema, validation and path anchoring, as `parseResolution` already does.
Expose that authority for the comparison; do not add another YAML parser or infer changes from diff text.
Read both revisions through the repository source. Never read the checkout as a substitute.

Compare parsed values structurally. Object key order, comments, whitespace, quoting and equivalent anchored glob spellings do not matter.
Arrays retain order and compare whole. Scalars compare by value and type.
Missing is distinct from every present value, including an explicit default or an empty collection.

Walk object members recursively, over the union of each side's names.
An added or removed object is walked against absence, so each changed value keeps its full key path.
Arrays, scalars and empty objects are comparison endpoints. An empty object's path is protected unless explicitly exempted.
The comparison does not inject defaults, merge ancestors, or validate a partial rule as a complete merged rule.
Full configuration loading remains responsible for checks that require inherited fields.

An addition, deletion or rename compares presence at each touched path separately.
A moved file therefore has an old-path removal and a new-path addition. Identical text at a new scope still counts.
An absent file contributes no declarations; it is not an unreadable file.

## Inheritance and moved keys

Ordinary configuration keeps the loader's existing precedence.
Objects merge per key; nearer arrays and scalars replace farther values. Globs anchor to their declaring file.
Resolution keeps its existing exception: the nearest file that speaks decides the finding whole.
The merged table and `preExisting` cap retain their existing layering.

A deeper file inherits every ancestor value it does not declare, subject to those rules and the built-in defaults.
The notice comparison reads declarations rather than the merged result.
Adding a declaration equal to an inherited value counts. Removing it to expose the same inherited value also counts.
Moving a key between two files counts at both files, even when one path's effective configuration stays equal.
The scopes and future inheritance have changed. An unchanged descendant file gets no extra notice merely because its ancestor changed.

## Unparseable or unreadable sides

Failure to parse, validate or read either present side counts as changed unknown policy.
This includes invalid YAML, unknown or forbidden keys, invalid values, symlinks and bounded-read refusals.
A changed file that cannot be compared draws the protected notice even when the parent disables it.
The explanation identifies the side that failed. It never pretends to know that side's key values.

The policy used to judge a change must still load successfully.
An invalid base `melian.yaml` already fails the whole check when guardrails loads its policy.
That failure remains a failure; a dismissible notice must not replace it.
If the comparison can proceed without loading that file as judging policy, its unreadable side draws the notice.
No catch converts an authority failure into unchanged policy or an empty layer.
Keep step 28's refusal for a Git path whose non-UTF-8 name cannot round-trip through the reader.
It fails the check rather than being compared as an absent file.

## Forced notice, resolution and dismissal

A protected difference forces the existing policy-change finding for that file, whatever the parent's `enabled` switch says.
Keep one finding per file and its existing `policy` or `analyser` discriminator, rule and stable ID.
For a protected difference outside `resolution`, add the optional typed class flag `blocking: true` to its guardrail metadata.
An unknown side also sets this flag, since its non-resolution keys cannot be cleared.
The ordinary `notice: policy|analyser` class remains. A simultaneous resolution change also keeps `resolution: true`.
Resolution-only changes retain their existing marker and resolution path.

Resolve a protected notice under the configuration that judged the file, as today.
Take the strictest of the files' tables alone, the existing notice-class resolution, and the new class entry
`guardrail/policy-change-review/blocking`. Then apply the acknowledgement floor.
No entry under `guardrails` may lower the tables' requirement. An entry asking more still applies.
The flag names a class of policy changes; it does not require every notice to resolve `block`.
Policy and analyser severities retain their existing selection, including a file configured as analyser input.

The root's notice stays forced on. Its severity and analyser severity remain at least their built-in defaults.
A nested file is still judged under the directory above its own, excluding its own settings.
A pull request uses the host-selected base policy. A head cannot lower the notice on the review proposing its change.
Working-tree reviews retain their existing host-selected policy and preference behaviour.
Forcing a notice does not add a check to a tier that omitted guardrails.

Step 28's trigger remains separate from semantic comparison.
Every emitted notice hashes `blob:` followed by the file's Git blob ID at head into its existing trigger hash.
A deleted file hashes `blob:` alone. The class flag, changed-key list and message never enter the stable ID or trigger.
When a notice reports again, any different blob reopens its dismissal, even if only formatting changed that blob.
An unrelated push with the same blob preserves dismissal. Triggerless legacy notices reopen on their next report.
Semantic equality suppresses the forced notice under an off switch; it does not replace the blob trigger on notices that do report.

An unresolved acknowledgement fails the published status until a maintainer dismisses it with a reason, as step 28 built.
Step 30 adds no dismissal authority or status exception.
The proposed metadata must round-trip through finding validation and storage.
Phase 2 must audit affected document versions and provide migrations and reopen fixtures wherever the stored contract changes.

## Visible explanation

Keep the notice's existing message identifying the file.
Its visible `explanation.what` also lists each changed protected endpoint in sorted key-path order, one per line:

```text
services/pay/melian.yaml: lenses.correctness.enabled: true -> false
services/pay/melian.yaml: static.mutation.maxLines: 2000 -> 1
```

Values use compact JSON, with object members sorted for display.
Use `<absent>` for absence. Dot-join ordinary key segments; bracket-quote a segment containing a dot or bracket to avoid ambiguity.
For a side that cannot be parsed, report the file's `$` comparison instead:

```text
services/pay/melian.yaml: $: <parsed> -> <unparseable>
```

An unreadable side uses `<unreadable>`; two failed sides name both failures.
The read error identifies the side and reason without quoting unparsed contents.
Do not invent an old or new value from a failed parse.
Existing renderers escape paths, values and controls before terminal or GitHub output.
This decision adds no new truncation: source bounds still apply, and publication retains its existing body limit.

## Existing resolution protection survives

A changed `resolution` key in any `melian.yaml` always draws its existing `resolution: true` notice.
A lens's changed declared resolution in a `LENS.md` does too.
Configuration uses its loader; lens resolution uses `Lens.load` at both commits in the folder the file governs.
That includes `extends` and a nearer lens definition. A side that does not parse counts as changed.
Their existing table-only comparison against class entries and acknowledgement floor remain.
Other lens-file changes remain under the parent's switch. This decision does not extend protection to every `LENS.md` field.
Only adjudication writes a finding's resolution; a lens's default remains a declared input.

Exempt `publish`, `models` and `knowledge` values keep the parent's switch, subject to the exact paths listed above.
A notice the switch leaves enabled is still reported, even for exempt-only edits.
Every notice on a `melian.yaml` still resolves at acknowledgement or above.
The root notice, base-policy judgement, notice classes and status requirement all survive the earlier decision.

## Evidence and phase 2 mutation inventory

Phase 1 adds ordinary regression tests against the unchanged implementation and passing controls.
They cover the listed families, the disabled parent, semantic equality, moved declarations, failure handling and visible values.
No production guard changes in phase 1, so there is no implementation mutation to claim.

Before implementation completes, prove each new guard by a failing mutation:

- Disable default protection; broaden each exemption to its parent; exempt a future schema sibling.
- Skip either comparison side, equate absence with defaults, compare raw text, or compare merged values alone.
- Ignore additions, removals, old rename paths, empty objects, array order or anchored paths.
- Treat a read or parse failure as unchanged, or turn invalid judging policy into a notice.
- Honour the parent's off switch for a protected change, drop its class, or let a ceiling lower the table-only result.
- Drop either old or new values or the file from the explanation, or make distinct key paths ambiguous.
- Drop the blob trigger, change its input, or change the notice's stable ID when marking the new class.

The host runs the cold mutation check before the first full round. The coordinator arranges the attacking review before phase 2.
