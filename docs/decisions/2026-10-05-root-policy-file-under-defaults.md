# The root melian.yaml is judged under the built-in defaults

Choice: policy-change-review judges a change to the root `melian.yaml` under the built-in defaults, so it always raises the notice at `P2`, whatever the root sets. A nested `melian.yaml` is still judged under the configuration of the directory above it, as [the lens-with-no-paths decision](2026-10-05-lens-with-no-paths.md) records, and what the root sets still governs every path beneath it.

Why: the root has no directory above it, so it was judged under its own settings, and a root that set `guardrails.policy-change-review.enabled: false` hid every later edit to itself. A pull request could then rewrite the repository's lens paths or guardrail rules with no maintainer asked to read the change. No configuration file switches off the review of itself, the root's included.
