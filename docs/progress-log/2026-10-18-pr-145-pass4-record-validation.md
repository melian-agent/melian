# Reject malformed publication records

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 4, validates REST review and comment records before pagination consumes them.
The first run failed 45 malformed-record cases. Some returned partial markers; others threw incidental type errors.
The provider now rejects the complete listing with its incomplete-page error.
IDs and comment links must be positive safe integers. Bodies and author logins have their documented types.
Deleted authors may be null, and roots may omit the optional reply link, as Octokit's API types allow.
An absent or null parent-review ID cannot establish ownership and rejects the listing.

Tests cover null elements, missing and malformed fields, zero, one, the safe-integer bound and one past it.
The final test includes a deleted reply author beside a valid signed root.
The mutation inventory and restored run are in `tmp/orphan-thread-pass4-report.md`.
This fix changes no stored shape, dependency, comparison record or plan status.
