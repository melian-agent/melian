# Models and credentials

pi-ai provides providers, OAuth subscription auth, and the model catalogue. Melian adds:

- **Model routing** from tier to model: `light`, `medium`, `heavy`, `decision`, and `verifier`, with fallbacks, read from the root's configuration until the plan resolves routes per path. A lens carries its tier's whole route, and moves to the next model when a provider failure outlasts pi-ai's retries or authentication fails. The route position is checkpointed with the model change, so a resumed review continues on the model it had reached.
- **The review plan**, which a resolver builds from routes, the catalogue, and the credentials present, below.
- **Credential sources**: the [secrets files](configuration-and-layering.md#files-a-user-owns), then Pi's credential store, so one `pi` login covers Melian locally, then environment variables; GitHub App installation tokens on the server and Actions hosts.
- **A credential pool provider** that holds several named credentials per provider and rotates on rate limit or failure, by stacking rules that name credentials. This is how subscriptions stack.

A named credential for an OAuth-only provider is a bearer token, never refreshed by Melian. The [named bearer decision](../decisions/2026-10-06-named-bearer-credentials.md) bounds JWT expiry to 30 days ahead and gives other values a rolling one-hour lease. Unusable named values yield to the next before Pi's login. A selected command returning an unusable bearer fails before durable review state is written. A review plans only lenses covering its changed paths. With none enabled and named by its checks, it unlocks no model credentials and opens no triage decider.
