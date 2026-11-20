# Issue 561: a parity run refuses anything but a regular file at its three names

Builder agent: the Actions round on [pull request #625](https://github.com/melian-agent/melian/pull/625) at 06ffc739 found two more defects in how a parity run handles its file names.

- 699a4addbd943aac: a FIFO at `<results>.lock` hangs the run, because opening it blocks.
- f15baac66189ca47: a dangling link outside the checkout that points into it passes the inside-checkout check. The write then lands inside the checkout.

That made two rounds running with a new instance of one class, so the builder raised the class instead of patching it. The coordinator answered on 2026-11-20, in its session. That was an answer on approach, not a maintainer's ruling.

A run now checks the results file, `<results>.lock` and `<results>.<pid>.tmp` with lstat. Anything at those names but a regular file is refused before it is opened, and an absent name is fine. The run no longer follows a link, which replaces the follow-and-hold that 08bae697 added. Only the last name is checked, so the directory may lie behind links. `checkoutCommit` resolves the parent directory and judges the name where it sits. The parent must exist.

The coordinator's note to resolve the parent in the lock too decides nothing there. A link to a directory reaches the same lock file through the filesystem anyway, and a manual mutant that drops the resolution survived every test. So only `checkoutCommit` resolves it.

On 06ffc739, the new and changed tests failed for the reported reasons:

- A link planted at the temporary path failed with `EEXIST` instead of the refusal.
- A results path that is a link to a file was followed, and the run printed the file's text in `Unexpected token 'K', "KEPT" is not valid JSON`.
- The link alias got the lock-held message.
- A link at the lock got the "not a lock" message.
- `checkoutCommit` refused a link outside the checkout to a file inside it.

The test of a results path under a linked directory passed there, as it should, since that behaviour has not changed. All 60 parity tests pass now.

The review of record at 06ffc739 raised two P3s, and the coordinator answered that neither gets new code on the lock. Both are now written as limits in the guideline and in `ResultsLock`'s comment:

- A hard link to a held results file is a second name the lock does not see.
- A lock replaced by something that is not a regular file while its run is going can block that run's next save.

Mutants: the enumerator listed 91 over `1b339d74...HEAD`, with none omitted, all in `parity.ts`. Every one ran by hand at this head, each against its named test alone, because the test file changed and every earlier claim's test file was on the rerun list.

- 80 were killed.
- 11 are equivalent, with reasons in the inventory. Two of them were killed claims in `2026-11-21-issue-561-lock-head-mutants.json`: claimant's catch and its fstat check. The lstat now refuses first, so only a swap between the lstat and the open reaches them. A third, holds()'s empty catch, was also listed as killed there, but it returns undefined, which both callers read as false.
- One more earlier claim, take's non-EEXIST rethrow, survived its old test, which now fails at the lstat. A results path in a missing directory now reaches it, and that case kills it.
- Seven manual rows: the three call sites of the check, the parent resolution in `checkoutCommit`, and a check that refuses a linked directory were killed. The two `O_NOFOLLOW` flags are reached only by such a swap.

The inventory is `2026-11-21-issue-561-lstat-rule-mutants.json`. It replaces `2026-11-21-issue-561-lock-head-mutants.json` and `2026-11-21-issue-561-checkout-link-mutants.json` as the proof for `parity.ts` at the head.
