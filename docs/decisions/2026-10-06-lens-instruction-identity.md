# Lens selection includes instruction identity

Date: 2026-10-06

A repeat review at the same revision reused a completed task after its worktree standards changed. The old task enforced old rules without asking the model again.

Each run fingerprints its stable rendered instructions, raw standards content and paths, source provenance, tools, rules, severities, budgets, coverage and change prompt. Rendering for identity uses a fixed boundary nonce; raw sections also enter the hash. Fresh random nonces therefore do not change identity or hide changes to section text. Escalated runs carry their own fingerprint in selection too.

Older tasks carry no fingerprint and cannot replace a newly fingerprinted run. The optional stored field needs no task migration.
