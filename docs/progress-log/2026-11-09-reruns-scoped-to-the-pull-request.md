# Inventory reruns are scoped to the pull request's own change

AGENTS.md's Briefs now applies the targeted rerun's rerun-all triggers to the pull request's own diff only, and runs the selected rerun once, at the final head. [The decision](../decisions/2026-11-09-reruns-scoped-to-the-pull-request.md) records the maintainer's ruling of 2026-11-09 and the hours that merges from `main` cost. Docs only, fast-tracked.
