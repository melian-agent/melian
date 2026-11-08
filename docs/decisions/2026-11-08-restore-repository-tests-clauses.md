# Restore the repository-tests clauses that partial supersessions retired

Amends: [2026-10-12-triage-records-keep-reachable-history.md](2026-10-12-triage-records-keep-reachable-history.md), restoring clauses that partial `Supersedes:` lines retired.

Status: accepted on 2026-11-08 under step 26's audit, [issue #238](https://github.com/melian-agent/melian/issues/238).

[Triage records keep their reachable history](2026-10-12-triage-records-keep-reachable-history.md) superseded [repository tests read the commit under test](2026-10-12-repository-tests-read-the-commit-under-test.md) for triage history and scratch history alone. The index retired the target whole. The clauses below still hold on main. This file restates them and changes nothing.

## From [2026-10-12-repository-tests-read-the-commit-under-test.md](2026-10-12-repository-tests-read-the-commit-under-test.md)

- Repository-scale assertions resolve HEAD once. They load expected decision paths, full titles and the rendered index from that commit.
- A fixture with 102 active decisions and no remote refs proves this path.
- The triage question set's current fingerprint must match its recorded version.
- No test requires a remote ref in the real checkout. Tests of branches and remote refs create those refs in their own fixture repositories.
