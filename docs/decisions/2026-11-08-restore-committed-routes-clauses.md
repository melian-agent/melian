# Restore the committed routes clauses that partial supersessions retired

Restores clauses for [2026-10-08-verifier-on-codex-subscription.md](2026-10-08-verifier-on-codex-subscription.md): the active decisions the partial `Supersedes:` chains below ended in. It declares no graph edge, so each of them can be superseded on its own.

Status: accepted on 2026-11-08 under step 26's audit, [issue #238](https://github.com/melian-agent/melian/issues/238).

Where a clause below conflicts with any other active decision, including the ones named above, that decision wins. These clauses fill gaps the partial supersessions left; they override nothing.

[2026-10-08-verifier-on-codex-subscription.md](2026-10-08-verifier-on-codex-subscription.md) superseded [2026-10-07-committed-routes.md](2026-10-07-committed-routes.md) while changing only the verifier's acceptance list and cross-family requirement. The index retired the target whole. The clauses below still hold on main; this file restates them and changes nothing.

## From [2026-10-07-committed-routes.md](2026-10-07-committed-routes.md)

- The root `melian.yaml` routes `heavy` to `openai-codex/gpt-6.1-sol`, accepting it, `anthropic/claude-opus-5-5`, and `openai/gpt-5.5`.
- Each route's fallbacks are its accepted models after the first, except the verifier's, which stay its Anthropic models.
- The routes are defaults, dynamic as usage allows: a maintainer may override them through `melian.local.yaml`, the user-level file, or `--model`, and a contributor without a credential gets a derived route.
