# A version-2 fingerprint is compared with version 2's recipe

Amends: [the decision to retire the legacy fingerprints](2026-10-24-retire-legacy-fingerprints.md), "The adjudication task now accepts only the current fingerprint", for a fingerprint of version 2 alone

Status: for [issue #502](https://github.com/melian-agent/melian/issues/502), on [pull request #525](https://github.com/melian-agent/melian/pull/525). The maintainer ruled on 2026-11-17, in the coordinator's session, for this option. It replaces the option the maintainer chose earlier that day, which let such a dismissal decide without comparing, before it landed.

## Problem

Pull request #525 changes how the resolution policy fingerprint is computed: each lens default keeps its variant's name and scope, and the hash is canonical JSON. The fingerprint's version moves from `2:` to `3:`. The adjudication task refuses a dismissal whose stored fingerprint differs from the one it computes, so every review stored before the change would refuse every dismissal.

Example: `packages/pipeline/test/caveats-reopen.test.ts` opens a store `main` wrote, whose review read its policy from the base commit. Dismissing a finding there failed with "the resolution policy changed since the review read it", though nothing about the policy had changed.

The first fix skipped the comparison for an older version when the policy came from a commit. Reviews then found three ways the policy behind one commit ID can differ from what the review read: a branch that moved, a replacement object under `refs/replace`, and a built-in lens default a newer build changed. Each let a dismissal decide under a policy the review never read.

## Choice

`configsFor` computes both recipes. `fingerprint` is version 3's, and `versionTwo` is version 2's, kept unchanged: plain JSON in the order files write their keys, and each lens report's default without its name or scope. A stored `2:` fingerprint must equal `versionTwo`, and every other stored fingerprint must equal `fingerprint`. Nothing is skipped.

- Version 2 is compared only when the review's policy came from a commit named by its full object ID. Git decides that, not the name's spelling: the name must equal the commit git resolves it to, in the repository's object format. A branch may be named with 64 hex characters in a SHA-1 repository, and 40 hex characters are an abbreviation in a SHA-256 one. A branch or an abbreviated ID can name another commit by now, and a working tree can change under one source, so a `2:` fingerprint there is compared with version 3's and refused.
- A fingerprint with no version stays refused, as the retired-fingerprints decision ruled.
- A fingerprint of a later version than the build's own is refused, since it equals neither recipe.
- The account reader compares with version 3's alone, so a recorded round from before the change reads not reviewed.

The tests use fingerprints `main`'s build wrote, at `c0b8b02e`, for one scenario under three policies, so the kept recipe is checked against the version that claims it.

The accepted cost: version 2's recipe stays in the code until no stored review names it. A later version change keeps only the recipe before it, or asks again.
