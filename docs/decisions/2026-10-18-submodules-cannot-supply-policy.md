# Submodules cannot supply policy, lenses or standards

Supersedes: none.

For [pull request #147](https://github.com/melian-agent/melian/pull/147), pass 4.

A gitlink at `.agents/lenses/correctness` exposes no `LENS.md` blob in the parent's diff.
Once initialised, its checked-out lens could narrow a local review without a policy notice.
A quiet parent could also silence a gitlink under `.melian/lenses`.

Both sources refuse to enter a submodule for repository policy, lenses or standards.
WorktreeSource recognises a directory's `.git` entry, whether a file or a directory, without reading or following it.
Such a directory has kind `other` in `exists` and directory listings; its descendants are absent.
This also refuses an embedded repository that has not been registered as a submodule.
RevisionSource already uses Git's gitlink mode and does not enter it; no revision implementation change is needed.
A symlink to a submodule remains a symlink and reaches the existing refusal.
Only missing markers mean a regular directory; other marker inspection failures refuse the read.

No extra notice is needed for a refused submodule: its policy cannot steer the parent's review.
The exact-spelling rule, policy classification, forced notices and dismissal binding remain unchanged.
Tests build real local submodules and run the lens, configuration and standards loaders through both sources.
