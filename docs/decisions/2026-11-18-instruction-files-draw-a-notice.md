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
- The notice quotes what the lens flagged: the rule, the path, the lines and the headline of each finding it reports in place of, since a finding that cites a second listed file is quoted in that file's notice too.

A person reads a listed file's flagged text as a notice. It is never silent to them: the notice needs acknowledgement, and an unresolved acknowledgement fails the published status until a maintainer dismisses it with a reason.

## Which files a repository lists

A listed file draws a notice on every change to it, and a notice is a read a person owes. On the host a read is a dismissal. So a repository lists a file only when it is mostly wording, or when it rarely changes, and keeps the pull requests that touch any listed file at about one in five. This rule is the coordinator's, given on 2026-11-20 in its session, not a ruling.

Melian's root `melian.yaml` was measured over the 100 pull requests merged before this one, from [pull request #308](https://github.com/melian-agent/melian/pull/308) to [pull request #579](https://github.com/melian-agent/melian/pull/579), diffing each merge against its first parent:

| File | Pull requests that touched it | Listed |
|---|---|---|
| `packages/pipeline/src/review.ts` | 23 | no |
| `packages/pipeline/src/lens-tools.ts` | 8 | no |
| `packages/pipeline/src/verification.ts` | 8 | no |
| `packages/pipeline/src/probing.ts` | 7 | no |
| `packages/core/src/lens.ts` | 5 | yes |
| `packages/pipeline/src/lens-request.ts` | 4 | yes |
| `packages/pipeline/src/summarize.ts` | 4 | yes |
| `docs/review-of-record.md` | 4 | yes |
| `packages/core/src/adjudication.ts` | 3 | yes |
| `packages/pipeline/src/untrusted.ts` | 3 | yes |
| `packages/pipeline/src/verification-instructions.ts` | 3 | yes |
| `packages/core/src/probing-wording.ts` | 2 | yes |
| `packages/pipeline/src/callers.ts` | 2 | yes |
| `packages/decisions/src/fallback.ts` | 1 | yes |
| each of the four `SKILL.md` files | 1 | yes |
| `packages/pipeline/src/enclosing-functions.ts` | 0 | yes |
| `AGENTS.md` | 50 | yes |

Of those 100, 20 touched at least one listed file other than `AGENTS.md`; with `lens-tools.ts`, `verification.ts` and `probing.ts` listed as well it was 24. `AGENTS.md` already draws a notice on every change as a policy file, so listing it adds no read.

An injection finding on prompt text in a file the list leaves off is reported as before, at P1. The fix is to move that prompt into a wording file, which then joins the list.

## Why

A file the base names as instructions is one the maintainer already expects to hold prompt text, so an injection finding there says what the notice says: a person must read this change. One notice, quoting the lens, asks for that read once. The list comes from the base so that a head cannot name a file to move its own hostile text off the injection finding.

## Limit

Hostile text in a listed file becomes a notice, not an injection finding. A maintainer who reads the notice sees the lens's headline and line, but the review no longer blocks on it as a P1.

A dismissed notice for the same base and head blobs keeps the replaced finding silent. The maintainer read that change once, and a new head that changes the file again reopens the notice.

The notice replaces a finding only in the file it covers. A lens finding that cites a second file, listed or not, needs a notice on every file it names.
