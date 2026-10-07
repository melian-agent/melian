# Required status: doctor

Branch `required-status` adds a trust line to `melian doctor`. It reads committed default-base policy, names the viewer and repository permission, and warns without failing for unknown or non-writing permission. It resolves the token once.

Tests use the fake GitHub transport. They cover head and uncommitted edits, writable and non-writing roles, refused reads, and a checkout with no base ref. The required-status switch remains pending.
