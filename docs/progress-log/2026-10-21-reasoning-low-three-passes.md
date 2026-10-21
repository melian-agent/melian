# Three passes behind low reasoning

Codex's adversarial review of [pull request #159](https://github.com/melian-agent/melian/pull/159) asked for three passes, per-pass counts and every heavy lens. The extension ran on the same build, `b10e7f67`: pass 3 of the first five corpora, three passes over contracts, removed-behaviour and conventions, and two more passes of Opus low.

The [run record](../../packages/evals/runs/2026-10-19-reasoning-levels.md) is rewritten with reported, true-positive, expected and found counts for each cell, lens and pass, and the worst and mean. The numbers agree with the earlier ones: low and medium both clear the precision bar. Three limits are now stated in the [decision](../decisions/2026-10-19-reasoning-low-for-heavy-and-triage.md): contracts recall of 0.50 at both levels, Opus low below the bar on design, and `openai/gpt-5.5` unmeasured. The decision also records that the maintainer keeps the walkthrough.

`origin/main` was merged into the branch after #157 landed. No route or code changed.
