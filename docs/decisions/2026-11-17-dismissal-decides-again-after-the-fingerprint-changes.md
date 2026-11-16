# A dismissal decides again after the policy fingerprint's computation changes

Amends: [the account policy decision](2026-11-16-account-names-its-resolution-policy.md)
Amends: [the decision to retire the legacy fingerprints](2026-10-24-retire-legacy-fingerprints.md), "The adjudication task now accepts only the current fingerprint"

Status: for [issue #502](https://github.com/melian-agent/melian/issues/502), on [pull request #525](https://github.com/melian-agent/melian/pull/525). The maintainer ruled on 2026-11-17, in the coordinator's session, for this option; [the comment on #525](https://github.com/melian-agent/melian/pull/525#issuecomment-6928816633) records it.

## Problem

Pull request #525 changes how the resolution policy fingerprint is computed: each lens default keeps its variant's name and scope, and the hash is canonical JSON. The adjudication task refuses a dismissal whose stored fingerprint differs from the one it computes now, so every review stored before the change refused every dismissal.

Example: `packages/pipeline/test/caveats-reopen.test.ts` opens a store `main` wrote, whose review read its policy from the base commit. Dismissing a finding there failed with "the resolution policy changed since the review read it", though the commit, and so the policy, had not changed.

## Choice

The fingerprint's version moves from `2:` to `3:`, held as the number `fingerprintVersion` in `packages/pipeline/src/configurations.ts`. When the stored fingerprint names an older version and the review read its policy from a commit, a dismissal decides again under the current computation: a commit cannot change, so only the computation differs.

The refusal stands everywhere else:

- A working-tree policy can change under one source, so an older version there is still refused.
- A fingerprint of the current version that differs is a different policy, whatever the source.
- A fingerprint with no version, the first recipe, stays refused, as the retired-fingerprints decision ruled.
- A fingerprint of a later version than the build's own is refused. Problem: a first form treated every version but the current one as older. Example: a store a newer Melian wrote holds `4:`; rolled back to this build, a dismissal would skip the comparison and decide under a computation that may miss inputs `4:` covers. Solution: only a version below the build's decides again. Codex's review found it.
- A commit named by a branch or an abbreviated ID is refused. Problem: such a name is read again on each read, so it can name another commit by the time a dismissal decides. Example: a review stored `2:` with its policy at `main`; `main` then moves to a commit that makes P2 advisory, and the dismissal would decide under the looser policy. Solution: only a full object ID, 40 or 64 hex characters, counts as a commit here. Every review the CLI starts names a full ID. Codex's review found it. Builder agent: this narrows "its policy came from a commit" to a name that fixes the commit; it is my reading of the ruling, not a ruling.

The account reader still compares fingerprints exactly, so a recorded round from before the change reads not reviewed. This ruling covers dismissals only.
