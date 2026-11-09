Fix pass 7 of [pull request #289](https://github.com/melian-agent/melian/pull/289) finished in a cloud builder session, taking over from the handoff at d14b8f49. It finished the mutation proof the handoff left partial. It also fixed what three more reviews found, and the maintainer ruled twice on the class they kept finding.

The class: a probe's setup writes into the tree as the reviewer, before the sandbox starts, and the tree holds the head's links. Five reviews found a write that a link carried outside the tree:
- Codex's adversarial review, through an allowlist copy;
- the first Actions round, through a workspace's `node_modules`;
- the coordinator's independent test review, through a case alias on macOS;
- the review of record, through a workspace's nested install;
- a probe the builder ran, through a link to the tree's own root.

The maintainer ruled on 2026-11-08 that a head whose links leave the tree is refused (0b2e73e3). The walk resolves each component as the kernel does, and matches the install by file identity (e5903809, ede749f7). On 2026-11-09 the maintainer ruled that dependency linking never writes through a link (5b7d2771). Its script stops at the first failure, checks every component for a link before each `mkdir -p`, and links with `ln -sn`. The static checks share the guard. [The decision](../decisions/2026-11-07-probes-run-under-sandbox-runtime.md) records both rulings.

The other fixes:
- 71833ff0: release only a sandbox wrap that succeeded.
- 14845ba0: hold the session while a late wrap is pending.
- f3087083: share one session count among wrappers of one runtime.
- a2711d10: keep a probe's result when its final stop fails.
- c57dde40: `melian probe` fails a probe whose stop failed.
- 842ca02e: doctor reports probes unavailable when an empty probe's teardown fails.
- dce23ec7 and 25b76f8f: the unix-socket test uses a readable path, under macOS's 104-byte limit.
- d450985c: the help text names the tracked tree.
- 56b62635: the decision names the variables sandbox-runtime adds, and `/sys`.
- 5b098827: records the one-second process identity as a limit. [Issue #352](https://github.com/melian-agent/melian/issues/352) tracks a finer one, by the maintainer's ruling on 2026-11-08.

Every fix began with a test that failed at its head for the reported reason, with three exceptions:
- The case-folding tests can fail only where the filesystem folds case. The coordinator ran them on macOS: they failed at 7e087263 with 59f7ba26's nested-install test, and passed at 59f7ba26.
- The PID-reuse limit is recorded, not fixed, by the maintainer's ruling.
- The two help-text and decision corrections are prose.

[The inventory](2026-11-09-pr-289-fix-pass-7-mutants.json) covers all 1,166 mutants of `origin/main...085cbc9e`:
- 1,055 killed against their named tests alone, each with exactly one test collected. Of those, 750 were rerun at 8a6f4c52 after `probe.test.ts` changed, 218 at 085cbc9e because the merge of `main` affected six CLI test files, and 77 stand from 59f7ba26, since nothing they depend on changed.
- 10 killed by new tests, each mutant run by hand.
- 10 killed by timeout: without line 316's outside check, the identity walk climbs past `/` forever.
- 101 equivalent, with a reason each. Eleven of them can be killed only on a case-folding filesystem, or only by a test that skips as root. macOS CI and the non-root CI jobs run those, and they passed at 085cbc9e.

It supersedes the partial inventory at bc582f5b.
