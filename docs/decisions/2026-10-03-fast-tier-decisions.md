# Fast-tier decisions

Choice: Enabled by default; degrade silently to guardrails and static when no provider is configured

Why: Semantic pre-commit checks are the point; the tier must never wait on an LLM
