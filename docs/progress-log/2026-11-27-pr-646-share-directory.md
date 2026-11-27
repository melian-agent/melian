# Pull request 646 follows links in git's share directory

Builder agent, for [pull request #646](https://github.com/melian-agent/melian/pull/646) and [issue #644](https://github.com/melian-agent/melian/issues/644).

Codex's adversarial review, which the coordinator ran on its host at 1584b2c1f, found that the macOS git lookup checked `share/git-core` by its spelling, while it checked git's program and exec path with links followed. A link at `<developer>/usr/share/git-core`, or at `<developer>/usr/share`, to a directory outside the developer tools passed the check, and the sandbox would then grant reads wherever the link led. The decision already said the share directory is checked with links followed; the code did not.

`probeGit` now resolves the share directory to its real path before the check, and grants that path. A share directory that does not exist leaves git unavailable, since its real path cannot be checked. Three tests in `packages/pipeline/test/probe-git.test.ts`, "a share directory inside the developer directory that links outside it", "a share directory whose parent links outside the developer directory" and "a share directory that does not exist", each failed before the fix, with the lookup granting git, and pass after.

[The inventory](2026-11-27-pr-646-share-mutants.json) of eb9430087 lists three mutants, and all three are string mutants the enumerator's configuration ignores, so none owes a claim. Each of the two on `probe-git.ts` line 52 still ran by hand against "grants git's one program, its exec path, its own files and its system configuration, and nothing else", which passed unmutated, and both failed it. Removing the `real` call, which Stryker does not generate, fails the three new tests.
