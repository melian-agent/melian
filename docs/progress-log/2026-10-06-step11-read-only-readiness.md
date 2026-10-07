# Step 11: read-only readiness

The final gate found that doctor tried to create a tool-cache directory before reading readiness. A sandbox with read-only git storage turned a missing executable into a failed doctor check.

ToolCache.open now opens without creating directories. Readiness only reads; materialisation creates its own parents. A regression checks that a missing cache stays absent and no fetch runs. The existing CLI doctor regression covers the sandbox case.
