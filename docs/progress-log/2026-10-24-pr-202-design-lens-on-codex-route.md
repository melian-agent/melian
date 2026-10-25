# 2026-10-24: the design lens runs on Codex's model and effort

[Pull request #202](https://github.com/melian-agent/melian/pull/202) routes `medium` to `openai-codex/gpt-5.6-sol` at `thinking: high`, and moves Melian's design lens to it. The lens's budget is 8 findings, 3,000,000 tokens and 150 tool calls. Every other lens's `quick` level moves to `light` through committed extensions, so `medium` serves the design lens alone. The maintainer chose this option on 2026-10-24, with a route per lens as plan step 37. Decision: [the design lens runs on Codex's model and effort](../decisions/2026-10-24-design-lens-on-codex-route.md).

The golden trees carry the new and changed repository lenses, as the corpus test requires. A test in `packages/core/test/lens.test.ts` holds the routing; six hand mutations of the routing files each failed it. Unmeasured: `quick` at `low` on Terra, and the design corpus on the new route.
