# Named bearer tokens

A named credential for `openai-codex` appeared in doctor and the review plan, but pi-ai discarded its API-key shape. The provider accepts only OAuth.

The credential store now reads each provider's auth kinds from the collection. It returns an API key where supported, or an OAuth credential carrying the named bearer and no refresh token. Providers accepting neither kind cannot count as credentialed; a named credential for one fails doctor, naming the provider.

JWT expiry comes from `exp`, converted from seconds to milliseconds without checking the signature. Other values get one hour from their first read, fixed for the process. Bearers use Pi's seven-minute cutoff. pi-ai attempts refresh within five minutes even with an empty refresh token; two more minutes cover the gap before use. Melian refuses writes and never refreshes. Refresh with the tool that owns the token, then review again.

Fake-provider tests cover command bearers, JWT claims and expiry, API keys, opaque tokens, the cutoff, and review route selection. Doctor tests name the bearer source without running its command. No test sends a request to a real provider.
