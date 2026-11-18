# Instruction files draw a notice in place of an injection finding

Status: the option is the maintainer's ruling of 2026-11-18, in the coordinator session: the base policy lists the instruction files, a change to one raises a policy notice in place of an injection finding, and the head cannot add its own file. The shape below, the key, the replacement rule and the quoting, is the coordinator's answer in that session, not a ruling. [Issue #565](https://github.com/melian-agent/melian/issues/565) asked for it.

Amends: [2026-10-17-acknowledge-status-exact-rule.md](2026-10-17-acknowledge-status-exact-rule.md), the floor that holds a `melian/injection-attempt` finding at `acknowledge`, for a finding an instruction-file notice reports in its place.
Amends: [2026-10-17-trust-floor-exact-rule.md](2026-10-17-trust-floor-exact-rule.md), the minimum of a `melian/injection-attempt` claim, for a finding an instruction-file notice reports in its place.

## Problem

Some files exist to hold the text a model reads as instructions: a lens's prompt, the verifier's brief, a reviewer's brief. A lens reads a change to one and sees text that addresses a reviewer. It reports `melian/injection-attempt` at P1, which blocks.

Example: a change rewrites the verifier's instructions in `packages/pipeline/src/verification-instructions.ts`. The new string tells a model to judge a claim by the code it cites. A lens reports it as an injection attempt, the round blocks, and a maintainer dismisses a finding about Melian's own prompt. The next round on the next head reports it again.

## Rule

- `guardrails.policy-change-review.instructions` is a list of globs, empty by default. Only a committed root `melian.yaml` sets it. A nested `melian.yaml`, a `melian.local.yaml` and user preferences are refused with `invalidValue`.
- The list comes from the policy revision alone, as every other policy key does. For a pull request that is the base. A head that adds its own file to the list draws an injection finding there as before, and a policy notice on its `melian.yaml`.
- A changed file the list matches draws the `guardrail/policy-change-review` notice, discriminator `policy`, even where the guardrail is turned off. The notice's trigger is the file's base and head blob identities, so a dismissal reopens when the file changes again. Its match carries `instructions: true`, and `Finding.floored` holds it at `acknowledge`.
- Adjudication reports a lens's injection finding through that notice when every file the finding names has one: its path, its trigger and proving hunks, and every evidence location of every claim. Lenses alone must have reported it, every report under `melian/injection-attempt`, each in one location. The finding resolves `silent`, its `decidedBy.replacedBy` names the notice, and it carries neither the injection floor nor a trust-floor minimum. It counts in no "Pre-existing, important" list and in no refuted list.
- A finding that names any file without such a notice is reported whole, at its own resolution and floors. So is one another rule or a check that is not a lens reported too.
- The notice quotes what the lens flagged: the rule, the lines and the headline of each finding it reports in place of.

A person reads a listed file's flagged text as a notice. It is never silent to them: the notice needs acknowledgement, and an unresolved acknowledgement fails the published status until a maintainer dismisses it with a reason.

## Why

A file the base names as instructions is one the maintainer already expects to hold prompt text, so an injection finding there says what the notice says: a person must read this change. One notice, quoting the lens, asks for that read once. The list comes from the base so that a head cannot name a file to move its own hostile text off the injection finding.

## Limit

Hostile text in a listed file becomes a notice, not an injection finding. A maintainer who reads the notice sees the lens's headline and line, but the review no longer blocks on it as a P1.

A dismissed notice for the same base and head blobs keeps the replaced finding silent. The maintainer read that change once, and a new head that changes the file again reopens the notice.

The notice replaces a finding only in the file it covers. A lens finding that cites a second file, listed or not, needs a notice on every file it names.
