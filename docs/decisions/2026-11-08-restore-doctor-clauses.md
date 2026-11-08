# Restore the doctor clauses that partial supersessions retired

Amends: [2026-10-06-doctor-github-read-deadline.md](2026-10-06-doctor-github-read-deadline.md), restoring clauses that partial `Supersedes:` lines retired.

Status: accepted on 2026-11-08 under step 26's audit, [issue #238](https://github.com/melian-agent/melian/issues/238).

[2026-10-06-doctor-stale-base-warning.md](2026-10-06-doctor-stale-base-warning.md) superseded [2026-10-06-doctor-base-policy.md](2026-10-06-doctor-base-policy.md) to add the stale local-main warning, and the decision this file amends superseded it to bound the GitHub reads. Each said it kept the earlier rules without restating all of them. The index retired each target whole. The clauses below still hold on main; this file restates them and changes nothing.

## From [2026-10-06-doctor-stale-base-warning.md](2026-10-06-doctor-stale-base-warning.md)

- Refresh the local base refs before a rehearsal.
- The stale local-main warning and the unknown-base warning both leave exit 0.

## From [2026-10-06-doctor-base-policy.md](2026-10-06-doctor-base-policy.md)

- Doctor has no pull request argument.
- The resolved token supplies one viewer lookup and one repository permission lookup.
- Unknown or non-writing permissions warn without failing doctor.
- Repository permission says nothing about a token's narrower scopes; GitHub enforces those when publication writes.
