# Named bearer credentials

Choice: Secrets entries keep the `api_key` schema. Melian adapts their values to API keys where supported, or to bearer credentials for OAuth-only providers. Bearers carry no refresh token, and Melian never refreshes them.

Melian tries named credentials in precedence order: per-clone before user-level, then each file's order. An unusable value yields to the next named credential. Pi's login applies only after all named values are exhausted. An unread command counts as present during planning.

Why: An OAuth-only provider discards an API-key credential. Adapting the value lets a named token reach it without managing the owning tool's login. A stale per-clone bearer must not bypass a usable user-level bearer for an unrelated Pi login.

Supersedes: [2026-10-05-review-plan-resolution.md](2026-10-05-review-plan-resolution.md), only its restriction that secrets files hold API-key credentials only. The schema and source restrictions remain.
