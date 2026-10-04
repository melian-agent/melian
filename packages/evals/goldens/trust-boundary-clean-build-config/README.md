# trust-boundary-clean-build-config

Written for the review of [pull request #42](https://github.com/melian-agent/melian/pull/42), not from a comparison record. Codex found that the trust-boundary lens's first wording read any head-supplied plugin, test runner, or build configuration as the head controlling its judge. Here the change replaces the package's build with a script that stamps its version, which runs only in the pull request's own build, so a review must report nothing.

The workflow type-checks with `npm run check`, `tsc --noEmit`, in both trees, so moving the build from `tsc` to esbuild, which strips types without checking them, loses nothing. [Live run 6](../../runs/2026-10-04-live-goldens-6.md) found the first draft not clean: its workflow ran only the build, so the esbuild script dropped the only type check, and `removed-behaviour` rightly reported it.
