# Named bearer credentials

Choice: Secrets entries keep the `api_key` schema. Melian adapts their values to API keys where supported, or to bearer credentials for OAuth-only providers. Bearers carry no refresh token, and Melian never refreshes them.

A numeric JWT `exp` claim, read without signature verification, supplies expiry when at most 30 days ahead. A larger claim or a token without a credible expiry gets a rolling one-hour lease on every read. A token inside the seven-minute cutoff is unusable: pi-ai refreshes within five minutes, and two more cover the gap before use.

Melian tries named credentials in precedence order: per-clone before user-level, then each file's order. An unusable value yields to the next named credential. Pi's login applies only after all named values are exhausted. An unread command counts as present during planning.

Before opening durable review storage, Melian unlocks each selected command and checks its bearer against the seven-minute cutoff. An unusable bearer fails the review with a credential error asking for refresh through the owning tool. It never silently replaces that planned source with Pi's login. Doctor runs no command.

Why: An OAuth-only provider discards an API-key credential. Adapting the value lets a named token reach it without managing the owning tool's login. A fixed lease would eject an opaque token after 53 minutes even though it may still be valid. Bounding an unsigned expiry claim prevents an arbitrary future date from pinning it for the process. A stale per-clone bearer must not bypass a usable user-level bearer for an unrelated Pi login. A command's result is unknown during planning, so failing closed keeps the stored plan from naming a source the review did not use.

Supersedes: [2026-10-05-review-plan-resolution.md](2026-10-05-review-plan-resolution.md), only its restriction that secrets files hold API-key credentials only. The schema and source restrictions remain.
