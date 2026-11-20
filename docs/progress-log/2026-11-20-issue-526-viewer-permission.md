# The viewer's own permission in a cloud session

[Issue #526](https://github.com/melian-agent/melian/issues/526) lets Melian read the token's own user's permission when GitHub's collaborator endpoint fails. A cloud session's proxy refuses that endpoint, so every head read as untrusted there, and a builder passed `--trust-head` for its own pushes. [The decision](../decisions/2026-11-20-viewer-permission-from-repository-endpoint.md) sets out the rule the maintainer ruled on 2026-11-20, in the coordinator's session.

- ec97cc2f3 adds `ownPermission` to the GitHub provider. It runs only after the collaborator endpoint fails, reads `GET /user` afresh, and answers only when that login is the asked login exactly. It then reads `GET repos/O/R`, checks `full_name` and the shape of `permissions`, and takes the highest true role. Anything else is unknown.
- `packages/github/test/viewer-permission.test.ts` holds the attacking review's cases as a suite, against a fake GitHub that answers only the requests a test names and records each one. Against main's code, 29 of its 33 tests failed and the 4 collaborator-authority cases passed. With the fix, all pass.
- Two caller tests in `packages/cli/test/writer-trust.test.ts` and one in `packages/cli/test/doctor.test.ts` take the fake's new `repositoryPermissions`. The head's own login is trusted with the collaborator endpoint refused, another pusher is not, and `melian doctor` names `viewer melian-user (admin)`. The first and third failed against main's code; all pass with the fix.
- 6373cae4 adds a test for every role the collaborator endpoint can answer, after the hand run found the role list's mutants for maintain, write, triage and none surviving.

`docs/design.md` and the cloud section of `AGENTS.md` say how the permission is read, and that a builder no longer needs `--trust-head` for a head its own login pushed. The proxy still refuses the status write.

## Mutation inventory

The inventory is [2026-11-20-issue-526-viewer-permission-mutants.json](2026-11-20-issue-526-viewer-permission-mutants.json), version 2 from `melian mutants list c2e68c4e...6373cae4 --claims-in packages/github/src/provider.ts --json --all`. It lists 74 mutants: 55 generated and 19 ignored by configuration. Of the 55, 54 are `killed` and 1 is `equivalent`. That one replaces `roles === null` with `false`: a null `permissions` then throws on the first role read, inside the `try`, and the catch returns unknown, which is what the guard returns. Each kill ran by hand at 6373cae4, against its named test alone, which passed unmutated first and failed under the mutant. [The runs](2026-11-20-issue-526-viewer-permission-mutant-runs.json) record each.
