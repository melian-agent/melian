# Thinking follows the model override guard

Amends: [2026-10-19-tier-thinking-routes.md](2026-10-19-tier-thinking-routes.md), local override protection and lineage.

A committed `thinking: high` must not become `off` through preferences when policy refuses model overrides.
The existing `acceptOverridden: false` guard also refuses a changed thinking level, before a model runs.
Moving a lens to another tier retains its committed tier's policy for models and thinking.
Where policy accepts overrides, check lineage records the effective level, committed level and source file.
Unset remains distinct from off. Thinking-only preferences still allow model derivation.

Verdict documents advance from 11 to 12 and adjudication tasks from 4 to 5 for the optional override lineage.
Existing records migrate unchanged. The version-11 fixture was written before changing those definitions and reopens twice without invented overrides.
