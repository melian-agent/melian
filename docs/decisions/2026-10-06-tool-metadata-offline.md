# Release metadata offline

Local gates must work without GitHub access. Static manifest and quarantine checks still run. Metadata verification sends GITHUB_TOKEN when present, and visibly skips an outage or rate limit locally. CI never skips it and receives GitHub’s job token. A metadata mismatch remains a failure everywhere. This changes the online gate requirement, not runtime archive authentication.
