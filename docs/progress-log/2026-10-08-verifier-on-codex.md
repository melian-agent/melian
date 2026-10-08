# Verifier on the Codex subscription

The verifier accepts `openai-codex/gpt-5.6-terra` through the ChatGPT subscription. Sonnet remains the default. An accepted same-family route prints a plan notice; an unaccepted one still warns and records its departure.

The recovered regression verifies a candidate through the OAuth-only fake provider, with and without a plan. It exercises provisional credential discovery, command unlocking and `hasCredentials`. Doctor names the resolved verifier route and provider on its routes line. A live design-golden regression runs the finder and a separate Terra verifier on the fake collection. No real provider was called.

Commits: `203c09c2` accepts the route; `e7f8a493` keeps accepted notices out of warnings; `28b6583f` proves subscription resolution; `8985c259` adds doctor routes; `ae92c88e` proves live design-golden routing. The documentation commit adds the [decision](../decisions/2026-10-08-verifier-on-codex-subscription.md) and updates the design and CLI guidance.

Mutation inventory: rejecting every accepted same-family route fails the accepted-case tests. Accepting every same-family route fails the unaccepted-case tests. Removing the routed-tier requirement fails the refusal regression whose verifier tier is unrouted. Accepting one fallback instead of every fallback fails the mixed-acceptance regression. Treating notices as warnings fails the notice regression.

Forcing the verifier credential lookup to Anthropic or OpenAI fails both subscription-resolution cases with `verifierFailed`. Replacing provisional credential discovery with a direct auth check runs the credential command during planning and fails both cases. Removing doctor’s routes line fails the subscription-verifier test. Ignoring the separate live verifier route fails the Terra design-golden test. The production pipeline and live runner already resolve the selected provider; these paths needed regression coverage, not provider-specific fixes.

The documentation and doctor summary add no guards, bounds or early returns. The full gate passed on the first run: 107 test files, 2,911 tests passed and 50 skipped. Each mutation’s failed test and the gate’s verbatim summary are recorded in `tmp/verifier-codex-report.md`.
