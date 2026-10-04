# Decider port home

Choice: The `Decider` interface lives in core beside the `ReviewProvider` port; its adapters, Jev, Clef on Workers AI, Clef self-hosted, recorded, and the LLM fallback, live in `packages/decisions`

Why: The same split as the provider port in core and the GitHub client in `packages/github`: core and the pipeline depend on the interface alone, stay unit-testable without a vendor, and a new decision provider is an adapter, not a change to core
