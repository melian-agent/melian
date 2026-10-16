# No alias for a provider ID Pi renames

Problem: pi-ai 1.1.0 registers the Azure provider as `azure`. Version 1.0.0 registered `azure-openai-responses`. Melian stores provider IDs as the user wrote them, in routes, preferences and named credentials, so a stored `azure-openai-responses` no longer resolves.

Example: a named credential for `azure-openai-responses` makes `createReviewModels()` throw `unknownProvider`, naming the credential, its file and the provider. A route that names the old ID finds no model, so the route skips to its next entry.

Choice: Melian adds no alias or migration. The catalogue is Pi's, and Melian's rule is to ask the authority rather than keep a second table of what Pi calls things. The credential error already names what to rewrite. The upgrade notes in [pull request #136](https://github.com/melian-agent/melian/pull/136) tell Azure users to change `azure-openai-responses` to `azure`. No other provider ID changed between the two catalogues that Melian ships a default for. Revisit if a user reports a silent route skip: the fix is a warning for a route entry no catalogue model matches, not an alias.
