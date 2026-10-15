[Pull request #98](https://github.com/melian-agent/melian/pull/98): the checked-out head rule, from the maintainer's words "fork code run locally -- skipped". Round seven's P1 `secret-exposure` (16aca2a5f7726220) showed the gap.

- 5a37ff6c: a checked-out head counts as the reviewer's own only when the branch holding it has no upstream, or tracks a branch of `origin`'s repository. `gh pr checkout` of a fork, a pull request ref, a missing remote, and a detached head no such branch holds all refuse. Tests use real git.
- ba89a7f4: `melian review --trust-head` runs the tests for a head the reviewer vouches for, and the check notes why. It has no environment variable.
- c7219f7a: a range whose head is not the reviewer's own reads its policy from the base, so a fork's `melian.yaml` cannot switch the check on.
- c081c0a9c184815c: Stryker's surviving mutant emptied the catch in `reportText`, which only returned `undefined` and so was equivalent to falling through. The catch now clears the text the try read, so an emptied catch returns a corrupt report and a test fails.

Mutations, each run by hand and each failing a test: an upstream-less branch refused or trusted when detached; any merge ref; any remote; no remote matching; no URL normalisation or lower-casing; the branch check skipped; a branch that does not hold the head taken; a git error trusted; detached reading only `HEAD`; the working tree's policy for a head that is not the reviewer's own; the flag ignored, always on, or not passed through; the note never or always; the catch emptied; the close removed.

The four `mutation/unmutated` notices stay by design.
