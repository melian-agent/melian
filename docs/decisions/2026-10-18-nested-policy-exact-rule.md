# Nested policy blob changes force the notice

Supersedes: [2026-10-16-nested-policy-keys-force-the-notice.md](2026-10-16-nested-policy-keys-force-the-notice.md)

Built for plan step 30 in [pull request #147](https://github.com/melian-agent/melian/pull/147), after an attacking review.
This replaces the phase 1 proposal with the coordinator's smaller rule.

## Problem

A nested `melian.yaml` is judged under the directory above it.
That directory may switch policy notices off.
A head can then disable correctness for a service without a maintainer answering a notice.
A `LENS.md` override that narrows correctness to `nothing/**` has the same effect.
The attack also found that `.agents/lenses/` was missing from the policy file list.

A separate dismissal gap survives a moved base.
Suppose a maintainer dismisses a change that enables Biome beside an already disabled correctness lens.
Main then enables correctness. The author merges main and keeps their own file.
The head blob stays the same, but the new diff disables correctness.
A trigger tied only to the head blob lets the old dismissal answer that unseen change.

## Rule

Every changed `melian.yaml` below the root draws a policy notice, whatever the parent's switch says.
Every changed lens file does too, at any depth, including the root:
`.melian/lenses/<name>/LENS.md` and `.agents/lenses/<name>/LENS.md`.
The lens filename and directory pattern use the lens loader's existing recognition rule.
`LENS.golden.md` fixtures do not qualify.

Git's blob identity is the authority. Compare the blob at the path at base and head.
A missing side contributes an empty identity. Additions and deletions count.
A rename counts at both paths, even when the content stays the same.
Formatting, comments, prompt bodies and every configuration key count. There are no per-key exemptions.
A mode-only change with equal blobs draws no forced notice.
An untouched descendant draws no extra notice when its ancestor changes.

Recognise `melian.yaml`, `AGENTS.md` and `CLAUDE.md` case-insensitively, as the maintainer's local and secrets files already are.
A case-insensitive filesystem opens a committed case variant under its canonical name.
The forced rule and acknowledgement floor recognise a case variant of `melian.yaml` too.
This recognises policy changes; it does not make revision readers resolve case variants as aliases.

## Resolution and explanation

Keep one finding per path, its existing `policy` or `analyser` discriminator, rule and stable ID.
The notice resolves at least `acknowledge` for every `melian.yaml` and lens file.
Keep the two notice classes and their existing severity selection. Add no `blocking` class flag.
Ordinary resolution precedence still applies above that floor.
An unresolved acknowledgement fails the published status until a maintainer dismisses it with a reason.

Keep step 18's additional resolution protection.
Compare a configuration's declared `resolution` through its parser, and a lens's effective declared default through `Lens.load`, at both commits.
A changed default, including one inherited through `extends`, marks the notice `resolution: true`.
A side that cannot be read or parsed still sets that marker conservatively.
A marked notice takes the stricter of table-only resolution and its existing class's resolution, then the acknowledgement floor.
Only adjudication writes resolution; the lens's default remains a declared input.
The message names the changed file without claiming that an unreadable side changed a particular key.
When the notice overrides a disabled parent switch, its explanation says so.

A nested configuration is still judged under the directory above it.
The root's notice stays forced, at least at the default severity and analyser severity, including after local preferences merge.
A pull request reads the host-selected base policy; a head cannot lower its own notice.
Forcing a notice does not add guardrails to a tier that omitted them.
Ordinary inheritance, glob anchoring, root-only restrictions and setting consumers stay unchanged.

## Dismissals bind both sides

Every policy notice, including analyser and standards notices, hashes `blob:<base blob>:<head blob>` into its existing SHA-256 trigger field.
Either changed side reopens dismissal. Unrelated commits that leave both blobs unchanged preserve it.
Stable finding IDs remain unchanged.
Previously stored head-only triggers differ from the new triggers, so an existing dismissal reopens once when its notice next reports.
That is the safe direction: the maintainer answers the change under the new content binding.
Triggerless notices also reopen on their next report, as before.
The stored shape and document versions stay unchanged; no migration is needed.

A Git lookup failure refuses the check with `CheckError unreadable`.
A non-UTF-8 policy name that cannot round-trip as a Git argument also refuses it.
An invalid base `melian.yaml` fails the check while loading judging policy, before notices are evaluated.
It cannot become a dismissible unknown-side notice.
Fix that base policy through a direct maintainer push or an allowed skip.
An unparseable head still draws the blob-change notice.

## Accepted residual risk

Analyser configuration and standards files remain under their parent's switch.
A quiet subtree can therefore change `biome.json`, `AGENTS.md` or `.melian/standards/` without a notice.
This includes an analyser change that affects the current head's run.
Forcing these notices would also flag fixture analyser files that Melian never runs.
Melian's golden repositories use the switch for that reason.
The maintainer who disables it accepts this risk.
Moving code beneath an existing lax sibling policy also changes its future review without changing a policy file.
The base already approved that sibling's policy.

The attack found zero extra notices across Melian's own history for the smaller rule.
It needs no semantic key walker, exemption list, new class or stored-shape change.
The mutation inventory covers path recognition, parent-switch bypass, equal blobs, both trigger sides, read failure and the acknowledgement floor.
The coordinator runs the cold mutation check on the host before the first full round.
