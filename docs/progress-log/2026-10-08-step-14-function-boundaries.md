# Step 14: shared function boundaries

The commit “fix(pipeline): carry ambiguous enclosing functions” closes Codex finding 2. Changed boundary lines carry every plausible scope within the existing caps. Tests distinguish a shared opening line, an inner edit, a shared closing line and deletion anchors. Restoring single-choice extraction fails the boundary tests.
