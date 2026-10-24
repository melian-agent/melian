# 2026-10-25: the design lens is measured against Codex every round

[Pull request #209](https://github.com/melian-agent/melian/pull/209) lets `melian compare` read the Codex companion's `adversarial-review --json` payload as it is. It adds `melian compare stats --lens <name> [--against <reviewer>]`, which counts the reviewer's valid defects a lens found, those only other checks found, and the lens's valid defects the reviewer found. AGENTS.md now runs Codex and the Melian round on one head each round and adjudicates every Codex finding before the next fix pass.

All 190 enumerated mutants were run by hand: 186 killed, 4 equivalent with reasons.
