# Step 14: resumed credentials

The commit “fix(cli): unlock providers stored by resumed tasks” closes Codex finding 1. The harness reads live tasks’ stored routes before the CLI’s first wait. A real SIGKILL restart changes the model route and proves that the stored provider unlocks first. Plan-only unlocking and each provider extraction mutation fail their tests.
