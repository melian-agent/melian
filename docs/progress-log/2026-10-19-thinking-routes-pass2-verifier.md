# Thinking routes: retain the verifier's configured level

[Pull request #157](https://github.com/melian-agent/melian/pull/157), pass 2, addresses Codex's verifier override finding.
Replacing the verifier model now retains its configured thinking.
The integration test overrides only heavy thinking and observes medium finder requests and low verifier requests through the fake provider's payload callback.
It covers both the general model override and an explicit verifier model, plus an unset verifier route.
Both configured cases failed first with empty verifier request bodies. All routing tests pass after the fix.

This pass also pushed `42528319` for policy protection and lineage, and `f763d46b` for triage measurement identity.
The report records every mutation, the full gate and its sandbox denials, and the final commit and CI state.
