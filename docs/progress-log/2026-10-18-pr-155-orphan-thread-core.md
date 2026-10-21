# Orphan-thread fix on main's identity rule

[Pull request #155](https://github.com/melian-agent/melian/pull/155) fixes [issue #132](https://github.com/melian-agent/melian/issues/132) and supersedes [pull request #145](https://github.com/melian-agent/melian/pull/145) for it.
#145 reached 9,189 changed lines, and five rounds each found a new publisher-identity defect in code an earlier pass had added.
The maintainer split it on 2026-10-18.

Cherry-picked from #145: 99322beb to d936c761, the owed-return fix, stale-thread retirement, incomplete-response probes and planning guards; 4a89189b, record validation; f6cf3be7 and 14edb852, nullable links; cb6c4709, 37cc3ca2 and 05d06049, tests.
Left out: ca188194, b50e99d0, 0d832c5f, and 694cf8c2 onwards, the identity line, now [issue #154](https://github.com/melian-agent/melian/issues/154).
Also left out, for size: e001f364's version-7 dismissal fixtures and 64b860e4's version-1 reopen test.
d936c761's version-7 fixture was written by #145's own pre-bump code, so a recording by main at `36122eb2` replaces it.

Kept from the taken commits: `ours()` decides roots as on main, and a reply counts only when its author matches its root's.
`melian.published` goes to version 9; no open pull request bumps it.
Main's version-8 snapshots, recorded through `publishReview`, prove the reopen.

New tests killed three survivors of the hand mutation run: an owed thread a human reopens no longer captures a finding live in its fresh thread (P16); a redismissal is stored under its thread and dismissal key (P12); a non-array comment page names the incomplete page (G16).
The suites that publish through the fake GitHub take a 60-second timeout.
Of 77 hand mutants, 75 are killed and 2 are equivalent.
