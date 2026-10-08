# Step 14: findings caps

The commit “fix(pipeline): end every lens at its findings cap” closes Codex finding 3. Self-capped and refused-report runs leave the review not reviewed, including when no hand-off rendered. Under-cap runs still count as complete. Restoring the hand-off condition fails the self-capped regressions.
