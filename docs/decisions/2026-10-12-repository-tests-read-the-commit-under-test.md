# Repository tests read the commit under test

Supersedes: none.

Problem: Stryker’s scratch repository contains only the reviewed commit and no remote refs. A repository-scale decision-index test required origin/main and failed the initial run before mutation testing began.

Choice: resolve HEAD once for repository-scale assertions. Load expected decision paths, full titles and the rendered index from that commit. Keep the active-decision count and byte headroom assertions. A fixture with 102 active decisions and no remote refs proves this path.

The triage fingerprint test reads questions.json from the committed HEAD snapshot, with no skip on an absent ref. Its current question fingerprint must match its recorded version. Historical record comparisons use fixture repositories and prove that an earlier version’s fingerprint cannot change.

Tests of branches, history and remote refs create those refs in their own fixture repositories. None requires a remote ref in the real checkout.

[Pull request #98](https://github.com/melian-agent/melian/pull/98) restores the mutation dry run without making either check vacuous.
