# Combine tool review context with step 9

[Pull request #89](https://github.com/melian-agent/melian/pull/89) merges main at 1d9fdcb0. Its Enola static check, verified graph cache, caller context and tool commands stay intact. Main's verifier, automatic deterministic checks and per-lens standards remain built.

The CLI runs checks before opening caller context and supplies their records to the review wrapper. Library callers retain automatic checks. Lens instructions accept both standards trust and advisory context. Their identity hashes each with a fixed nonce. Standards remain trusted only when their source resolves to the policy commit.

The skills retain both tool readiness guidance and the standards inventory explanation. The Claude Code source was resolved first and copied to the checked-in skill. Documentation retains step 11's built work beside main's verifier and step 9 status.
