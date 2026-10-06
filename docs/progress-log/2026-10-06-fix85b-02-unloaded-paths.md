# Refuse standards for unloaded paths

[Pull request #85](https://github.com/melian-agent/melian/pull/85), second fix pass, item 2.

Both source kinds silently returned no sections for an unknown directory and accepted an unrequested sibling. Four failing probes confirm the gap. forFiles now throws StandardsError with pathNotLoaded for either case. Its exported contract and the core guideline name the error.
