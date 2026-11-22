# The viewer's own permission may come from the repository endpoint

Status: the maintainer agreed the direction on 2026-11-17, in the coordinator session. When the login Melian must check is the authenticated user itself, Melian may take that user's permission from the repository endpoint. Any other login still goes to the collaborator endpoint, and it fails closed when Melian cannot tell. On 2026-11-20, in the coordinator session, the maintainer ruled on the rule below, with the two cases the attacking review left open: a 200 with an unknown role is an answer, and every failure of the collaborator endpoint falls back alike. [Issue #526](https://github.com/melian-agent/melian/issues/526) records both rulings.

## Problem

Before Melian runs a head's code in a probe or a test, it checks that the head's pusher is a writer, by asking GitHub's collaborator endpoint, `GET repos/O/R/collaborators/L/permission`. A Claude Code cloud session reaches GitHub through a proxy that refuses that endpoint with HTTP 403, so every login reads as having no known permission.

Example: on 2026-11-16 a builder finishing [pull request #499](https://github.com/melian-agent/melian/pull/499) in a cloud session ran a round whose probing lens did not probe, because "redbeard has no known permission on the repository". `melian doctor` printed `viewer redbeard (unknown)`. The same session's `gh api repos/melian-agent/melian --jq .permissions` answered `{"admin":true,"maintain":true,"pull":true,"push":true,"triage":true}`.

## Rule

`GitHubProvider.permission(login)` decides as follows.

1. It asks the collaborator endpoint first, for every login. When that endpoint answers with status 200, its answer is the authority, and the repository endpoint is not asked. A 200 whose `permission` is missing or unknown is still an answer: the result is unknown, with no fallback.
2. Only when the collaborator endpoint fails, whatever the status or error, does it ask `GET /user`, afresh on each call. A viewer cached from a posted review's author does not count. If `/user` is refused, as it is for an installation token, the result is unknown.
3. If `/user`'s `login` equals the asked login exactly, it asks `GET repos/O/R`. GitHub returns both in their canonical case, so a case-only difference means the login came from somewhere else, and the result is unknown.
4. It accepts that answer only when `full_name` equals `O/R`, ignoring case, and `permissions` is a non-null object that is not an array. A renamed or moved repository redirects, and its `full_name` then names another repository.
5. It takes the highest role whose value is `true`: `admin`, then `maintain`, then `push` as `write`, then `triage`, then `pull` as `read`. The result is `none` when none is true.
6. Any other failure leaves the result unknown, and every caller already treats unknown as no trust.

The two answers are never combined, so they cannot disagree. Its three callers, `writerTrust`, `melian doctor` and publish's ledger record, change nothing else. The merge-group check keeps its own collaborator lookup.

## What each endpoint proves

- The collaborator endpoint gives the named login's effective role, for any login.
- The repository endpoint's `permissions` gives the token's own user's effective role, and nothing about any other login.
- Neither says what the token's scopes allow, so neither proves that a status write will succeed. That is no different on the host: publish treats a refused write as not published.
- The collaborator endpoint's `permission` field reports maintain as `write` and triage as `read`; the precise role is in `role_name`. The repository endpoint names `maintain` and `triage` themselves. Whether a login is a writer is the same either way.

## What a 404 means

The rule falls back after a 404 as after any failure. That would be wrong if a 404 could mean "this user is not a collaborator". On 2026-11-20 the coordinator checked GitHub from the host, on this public repository:
- a real user who is not a collaborator, `octocat`, got 200 with `permission: read`;
- a login that does not exist got 404, "is not a user".

So on a public repository a 404 never stands for a user without access. A private repository was not checked.

## What "a writer" means here

Every builder pushes and posts as the maintainer's login. So a trusted head means "pushed with the maintainer's token", not "pushed by a particular agent", in a cloud session exactly as on the host. The rule adds no new trust; it reaches the same answer by the one route that speaks only for the token's own user.

## What it gives up

- Neither endpoint proves what the token's scopes allow, so a trusted head does not mean the status write will succeed. In a cloud session it does not: the proxy still refuses `POST repos/<repo>/statuses/<sha>`.
- The fallback answers for one login, the token's own. A head another login pushed stays untrusted in a cloud session, as before.

## Limit

- A private repository's 404 is unchecked.
- The ledger does not record which endpoint answered. Its stored shape is left alone.
